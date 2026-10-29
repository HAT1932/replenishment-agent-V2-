/**
 * AiExplainPanel.tsx — 「AI 解读」：让模型用人话解释这条建议为什么这么补
 * ---------------------------------------------------------------------------
 * PRD US-01/US-02 的落点：
 *   - 服务端 `POST /api/explain` 先算出确定性因子，再让模型写四段解释；
 *   - 返回里带 **数值对账**（verification）：模型说的每个数字必须在 factor 数据里出现，
 *     没出现的列出来——这就是"可解释"和"讲得顺"的区别；
 *   - 同时展示因子分解（可加回）、置信度/紧急度（PRD 增强指标）与 What-if 确定性重算。
 *
 * 纪律：本组件不算任何数，只渲染服务端字段；模型输出仅作文本展示，不参与计算。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiPost, errorMessage } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { fmtInt } from '../../lib/format';
import type { Suggestion } from '../../app/types';

interface Verification {
  ok: boolean;
  checked: number;
  grounded: number;
  unknown: string[];
}

interface Factor {
  name: string;
  value: number | null;
  unit: string;
  impact: number;
  direction: 'up' | 'down' | 'multiplier' | string;
  detail?: string;
}

interface Grounding {
  factors: Factor[];
  confidence?: { level: string; label: string; reasons: string[] } | null;
  urgency?: { level: string; label: string; reasons: string[]; safety_line?: number } | null;
  anomaly?: Array<{ type: string; label: string; detail: string }>;
  factor_identity?: { sum: number; raw: number | null; ok: boolean } | null;
  assumptions?: string[];
  provenance_boundary?: string;
}

interface ExplainResult {
  text: string;
  source: 'llm' | 'deterministic' | string;
  model: string | null;
  degraded: boolean;
  degraded_reason?: string | null;
  verification: Verification;
}

interface WhatIfResult {
  before: { suggest_num: number; amount: number };
  after: { suggest_num: number; amount: number };
  delta: { qty: number; amount: number; qty_pct: number | null };
  factor_delta: Array<{ name: string; before: number; after: number; delta: number }>;
  arrival?: { before?: string; after?: string; changed: boolean };
  parameter_effects?: Record<string, string>;
  notes?: string[];
  overrides?: { applied: Record<string, number>; rejected: Array<{ key: string; reason: string }> };
}

const WHATIF_PRESETS: Array<{ label: string; overrides: Record<string, number> }> = [
  { label: '目标可售 +10 天', overrides: { coverage_days: 25 } },
  { label: '补货前置期 +2 天', overrides: { purchase_cycle_days: 9 } },
  { label: '缓冲天数 +2 天', overrides: { safety_days: 5 } },
];

/** 把解释文本按行拆段，并把【小标题】加粗 */
function ExplainText({ text }: { text: string }) {
  // 模型偶尔会带 markdown 强调，渲染前剥离（纯文本展示，避免出现 ** 字样）
  const clean = String(text).replace(/\*\*/g, '').replace(/`/g, '');
  const lines = clean.split(/\n+/).filter((line) => line.trim() !== '');
  return (
    <div className="ra-ai-text">
      {lines.map((line, index) => {
        const match = /^(【[^】]+】)(.*)$/.exec(line.trim());
        if (match) {
          return (
            <p key={index} className="ra-ai-para">
              <strong className="ra-ai-heading">{match[1]}</strong>
              {match[2]}
            </p>
          );
        }
        return (
          <p key={index} className="ra-ai-para">
            {line}
          </p>
        );
      })}
    </div>
  );
}

export function AiExplainPanel({ suggestion }: { suggestion: Suggestion }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [explain, setExplain] = useState<ExplainResult | null>(null);
  const [grounding, setGrounding] = useState<Grounding | null>(null);

  const [whatif, setWhatif] = useState<WhatIfResult | null>(null);
  const [whatifLoading, setWhatifLoading] = useState(false);
  const [whatifError, setWhatifError] = useState<string | null>(null);

  const skuCode = suggestion.sku_code;

  const generate = useCallback(async () => {
    if (!skuCode) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiPost<{ explanation: ExplainResult; grounding: Grounding }>('/explain', {
        sku_code: skuCode,
        ...(suggestion.as_of ? { as_of: suggestion.as_of } : {}),
        ...(suggestion.plan_id ? { plan_id: String(suggestion.plan_id) } : {}),
      });
      setExplain(res.explanation);
      setGrounding(res.grounding);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [skuCode, suggestion.as_of, suggestion.plan_id]);

  // 抽屉一打开就自动生成一次（用户点「解释」的意图就是"给我解释"）
  useEffect(() => {
    if (!skuCode) return;
    setExplain(null);
    setGrounding(null);
    setWhatif(null);
    setWhatifError(null);
    void generate();
  }, [skuCode, generate]);

  const runWhatIf = useCallback(
    async (overrides: Record<string, number>) => {
      if (!skuCode) return;
      setWhatifLoading(true);
      setWhatifError(null);
      try {
        const res = await apiPost<WhatIfResult>('/whatif', {
          sku_code: skuCode,
          overrides,
          ...(suggestion.plan_id ? { plan_id: String(suggestion.plan_id) } : {}),
        });
        setWhatif(res);
      } catch (err) {
        setWhatifError(errorMessage(err));
      } finally {
        setWhatifLoading(false);
      }
    },
    [skuCode, suggestion.plan_id],
  );

  const copy = useCallback(async () => {
    if (!explain?.text) return;
    try {
      await navigator.clipboard.writeText(explain.text);
      toast('已复制解释文本', 'ok');
    } catch {
      toast('复制失败，请手动选择文本', 'err');
    }
  }, [explain?.text, toast]);

  const verification = explain?.verification;
  const factors = useMemo(() => grounding?.factors ?? [], [grounding]);

  if (!skuCode) return null;

  return (
    <section className="ra-ai" aria-label="AI 解读">
      <div className="ra-ai-head">
        <div className="ra-ai-title">
          <span className="ra-ai-badge">AI 解读</span>
          <span className="ra-hint">模型只用服务端给到的因子与数字写解释，逐句可对账</span>
        </div>
        <div className="ra-ai-actions">
          {explain ? (
            <button type="button" className="ra-btn ra-btn-sm ra-btn-ghost" onClick={() => void copy()}>
              复制
            </button>
          ) : null}
          <button type="button" className="ra-btn ra-btn-sm" onClick={() => void generate()} disabled={loading}>
            {loading ? '生成中…' : explain ? '重新生成' : '生成解释'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="ra-error-text" role="alert">
          解释生成失败：{error}
        </div>
      ) : null}

      {loading && !explain ? (
        <div className="ra-ai-loading">
          <span className="ra-spinner" aria-hidden="true" /> 正在让模型读因子并写解释（约 5–10 秒）…
        </div>
      ) : null}

      {explain ? (
        <>
          <div className="ra-ai-badges">
            <span className={`ra-tag ${explain.source === 'llm' ? 'ra-tag-info' : 'ra-tag-warn'}`}>
              {explain.source === 'llm' ? `模型生成 · ${explain.model ?? 'LLM'}` : '确定性兜底（模型不可用）'}
            </span>
            {verification ? (
              <span
                className={`ra-tag ${verification.ok ? 'ra-tag-ok' : 'ra-tag-danger'}`}
                title={
                  verification.ok
                    ? `已核对 ${verification.checked} 个数字，全部能在服务端因子中找到`
                    : `以下数字未在服务端数据中找到：${verification.unknown.join('、')}`
                }
              >
                {verification.ok
                  ? `数字已对账 ${verification.grounded}/${verification.checked}`
                  : `⚠ ${verification.unknown.length} 个数字未溯源`}
              </span>
            ) : null}
            {explain.degraded && explain.degraded_reason ? (
              <span className="ra-tag ra-tag-warn" title={explain.degraded_reason}>
                降级原因见 tooltip
              </span>
            ) : null}
          </div>

          {!verification?.ok && verification?.unknown?.length ? (
            <div className="ra-ai-verify-warn">
              该解释里出现服务端数据中不存在的数字：{verification.unknown.map((item) => `「${item}」`).join(' ')}
              —— 请以因子表为准，或重新生成。
            </div>
          ) : null}

          <ExplainText text={explain.text} />
        </>
      ) : null}

      {factors.length > 0 ? (
        <div className="ra-ai-factors">
          <div className="ra-ai-subtitle">
            决策因子（可加回）
            {grounding?.factor_identity ? (
              <span className="ra-hint">
                {' '}
                Σ 因子 = {grounding.factor_identity.sum} = 未截断值{' '}
                {grounding.factor_identity.raw ?? '—'} {grounding.factor_identity.ok ? '✓' : '⚠ 未对齐'}
              </span>
            ) : null}
          </div>
          <ul className="ra-ai-factor-list">
            {factors.map((factor) => (
              <li key={factor.name} className="ra-ai-factor">
                <span className={`ra-ai-factor-dir ra-ai-dir-${factor.direction}`} aria-hidden="true">
                  {factor.direction === 'multiplier' ? '×' : factor.impact >= 0 ? '▲' : '▼'}
                </span>
                <span className="ra-ai-factor-name">{factor.name}</span>
                <span className="ra-ai-factor-impact">
                  {factor.impact >= 0 ? '+' : ''}
                  {factor.impact} {suggestion.unit ?? '件'}
                </span>
                <span className="ra-hint ra-ai-factor-detail">{factor.detail ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {grounding?.confidence || grounding?.urgency || (grounding?.anomaly?.length ?? 0) > 0 ? (
        <div className="ra-ai-signals">
          {grounding?.confidence ? (
            <span className="ra-tag ra-tag-gray" title={grounding.confidence.reasons.join('；')}>
              置信度 {grounding.confidence.label}
            </span>
          ) : null}
          {grounding?.urgency ? (
            <span
              className={`ra-tag ${grounding.urgency.level === 'critical' ? 'ra-tag-danger' : grounding.urgency.level === 'high_stock' ? 'ra-tag-info' : 'ra-tag-warn'}`}
              title={grounding.urgency.reasons.join('；')}
            >
              紧急度 {grounding.urgency.label}
            </span>
          ) : null}
          {(grounding?.anomaly ?? []).map((item) => (
            <span key={item.type} className="ra-tag ra-tag-purple" title={item.detail}>
              异常 {item.label}
            </span>
          ))}
        </div>
      ) : null}

      <div className="ra-whatif">
        <div className="ra-ai-subtitle">
          What-if 确定性重算
          <span className="ra-hint"> 改参数由服务端内核重算（不是模型估算）</span>
        </div>
        <div className="ra-whatif-presets">
          {WHATIF_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="ra-btn ra-btn-sm ra-btn-ghost"
              disabled={whatifLoading}
              onClick={() => void runWhatIf(preset.overrides)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {whatifError ? <div className="ra-error-text">What-if 失败：{whatifError}</div> : null}

        {whatif ? (
          <div className="ra-whatif-result">
            <div className="ra-whatif-delta">
              <span>
                {fmtInt(whatif.before.suggest_num)} → <strong>{fmtInt(whatif.after.suggest_num)}</strong>{' '}
                {suggestion.unit ?? '件'}
              </span>
              <span className={whatif.delta.qty === 0 ? 'ra-hint' : whatif.delta.qty > 0 ? 'ra-num-danger' : 'ra-tag-ok'}>
                Δ {whatif.delta.qty > 0 ? '+' : ''}
                {whatif.delta.qty} 件{whatif.delta.qty_pct !== null ? `（${whatif.delta.qty_pct}%）` : ''}
              </span>
              {whatif.arrival?.changed ? (
                <span className="ra-hint">
                  到货 {whatif.arrival.before} → {whatif.arrival.after}
                </span>
              ) : null}
            </div>
            {whatif.delta.qty === 0 ? (
              <div className="ra-hint">
                该参数对数量无影响
                {whatif.arrival?.changed ? '（只改变预计到货日）' : ''}
                {whatif.parameter_effects?.[Object.keys(whatif.overrides?.applied ?? {})[0] ?? ''] ? (
                  <>：{whatif.parameter_effects[Object.keys(whatif.overrides?.applied ?? {})[0] ?? '']}</>
                ) : null}
              </div>
            ) : null}
            {whatif.factor_delta.length > 0 ? (
              <ul className="ra-whatif-factors">
                {whatif.factor_delta.map((item) => (
                  <li key={item.name}>
                    {item.name}：{item.before} → {item.after}（Δ{item.delta > 0 ? '+' : ''}
                    {item.delta}）
                  </li>
                ))}
              </ul>
            ) : null}
            {whatif.notes?.length ? <div className="ra-hint">{whatif.notes[0]}</div> : null}
          </div>
        ) : null}
      </div>

      {grounding?.provenance_boundary ? (
        <div className="ra-ai-boundary">{grounding.provenance_boundary}</div>
      ) : null}
    </section>
  );
}

export default AiExplainPanel;
