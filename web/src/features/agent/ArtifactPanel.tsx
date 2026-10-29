/**
 * ArtifactPanel.tsx — 右侧「产物面板」
 * ---------------------------------------------------------------------------
 * 契约 §7：`#/agent` 左会话 / 右产物。产物由 SSE `artifact` 事件驱动：
 *   - kind='suggestions' → 用 artifact.ref 里的查询参数回查 `/api/suggestions`，渲染建议表（9 列 + Δ + 逐日系数）
 *   - kind='explain'     → 回查 `/api/sku/:code`，渲染解释链（terms / 逐日系数 / 闸门 / 分步推导）
 *   - kind='draft'       → 回查 `/api/drafts/:id`，渲染草稿卡（含审批下拉 → 提交）
 *
 * 纪律：产物面板**不自己算数字**，只回查服务端；KPI 一律用服务端 kpi。
 */
import { useCallback, useMemo } from 'react';
import { apiGet } from '../../lib/api';
import { useAsyncData } from '../../lib/hooks';
import { fmtDec, fmtInt } from '../../lib/format';
import { EmptyState, ErrorState, LoadingBlock } from '../../components/States';
import { CitationStrip } from '../../components/Citation';
import { SuggestionsPanel } from '../suggestion/SuggestionsPanel';
import { DraftCard } from '../order/DraftCard';
import { navigate } from '../../app/router';
import type {
  Artifact,
  Approval,
  Draft,
  ExplainPayload,
  Order,
  SkuDetail,
  SuggestionsResponse,
} from '../../app/types';

export interface ArtifactPanelProps {
  artifacts: Artifact[];
  approvals: Approval[];
  onCommitted?: (order: Order, draft: Draft) => void;
}

/** 星期标签（0=周日） */
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];


function refObject(ref: Artifact['ref']): Record<string, unknown> {
  return ref && typeof ref === 'object' ? (ref as Record<string, unknown>) : {};
}

/** 建议产物：按 ref 里的参数回查服务端（不缓存旧结果，保证与 SSOT 一致） */
function SuggestionsArtifact({ artifact, sessionId }: { artifact: Artifact; sessionId: string | null }) {
  const ref = refObject(artifact.ref);
  const query = useMemo(
    () => ({
      ...(ref.plan_id ? { plan_id: String(ref.plan_id) } : {}),
      ...(ref.store_id ? { store_id: String(ref.store_id) } : {}),
      ...(ref.category ? { category: String(ref.category) } : {}),
      ...(ref.keyword ? { keyword: String(ref.keyword) } : {}),
      ...(ref.as_of ? { as_of: String(ref.as_of) } : {}),
      ...(ref.expected_arrival ? { expected_arrival: String(ref.expected_arrival) } : {}),
      ...(ref.only_low !== undefined ? { only_low: Boolean(ref.only_low) } : {}),
      page_size: 50,
    }),
    [artifact.ref],
  );

  const state = useAsyncData<SuggestionsResponse>(
    (signal) => apiGet<SuggestionsResponse>('/suggestions', query, signal),
    [JSON.stringify(query), artifact.id],
  );

  if (state.loading && !state.data) return <LoadingBlock text="正在回查建议产物…" />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} compact />;
  const data = state.data;

  return (
    <SuggestionsPanel
      embedded
      data={data}
      loading={state.loading}
      error={state.error}
      onRetry={state.reload}
      title={artifact.title ?? '补货建议'}
      subtitle={
        data
          ? `数据日期 ${data.as_of ?? '—'} · 预计到货 ${data.expected_arrival ?? '—'} · 共 ${fmtInt(data.total ?? data.rows?.length ?? 0)} 行`
          : undefined
      }
      sessionId={sessionId ?? undefined}
    />
  );
}

/** 解释产物：回查 SKU 详情，展示 terms / 逐日系数 / 闸门 / 分步推导 */
function ExplainArtifact({ artifact }: { artifact: Artifact }) {
  const ref = refObject(artifact.ref);
  const skuCode = ref.sku_code ? String(ref.sku_code) : '';
  const state = useAsyncData<SkuDetail>(
    (signal) =>
      skuCode
        ? apiGet<SkuDetail>(`/sku/${encodeURIComponent(skuCode)}`, {
            ...(ref.as_of ? { as_of: String(ref.as_of) } : {}),
          }, signal)
        : Promise.reject(new Error('产物缺少 sku_code，无法回查')),
    [skuCode, artifact.id],
  );

  if (!skuCode) return <EmptyState title="解释产物缺少 sku_code" text="请回到会话重新生成" />;
  if (state.loading && !state.data) return <LoadingBlock text="正在回查解释链…" />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} compact />;

  const detail = state.data;
  const explain: ExplainPayload | undefined = detail?.explain ?? undefined;
  const coefficientDays = explain?.coefficient_detail ?? [];

  return (
    <div className="ra-card ra-artifact">
      <div className="ra-artifact-head">
        <div>
          <div className="ra-artifact-title">{artifact.title ?? `建议解释 · ${skuCode}`}</div>
          <div className="ra-hint">
            {detail?.sku?.product_name ?? skuCode} · {detail?.sku?.spec ?? ''} · 数据日期 {ref.as_of ? String(ref.as_of) : '—'}
          </div>
        </div>
        <button className="ra-btn ra-btn-ghost ra-btn-sm" onClick={() => navigate(`/sku/${skuCode}`)} style={{ display: 'none' }}>
          打开详情
        </button>
      </div>

      {explain?.formula_text ? (
        <CitationStrip compact formulaText={explain.formula_text} assumptions={[]} />
      ) : null}

      {explain?.guard ? (
        <div className="ra-explain-guard" data-alert={explain.guard.passed === false ? 'false' : 'true'}>
          <span className="ra-tag">{explain.guard.policy ?? '闸门'}</span>
          <span>{explain.guard.text ?? '—'}</span>
        </div>
      ) : null}

      {coefficientDays.length > 0 ? (
        <div className="ra-coef">
          <div className="ra-coef-title">逐日综合系数（{coefficientDays.length} 天）</div>
          <div className="ra-coef-bars">
            {coefficientDays.map((day) => {
              const max = Math.max(...coefficientDays.map((d) => Number(d.factor) || 1), 1.2);
              const height = Math.max(6, (Number(day.factor) / max) * 64);
              return (
                <div key={day.date} className="ra-coef-bar" title={`${day.date} ${WEEKDAY[day.weekday ?? 1]} ×${day.factor} ${(day.reasons ?? []).join("/")}`}>
                  <div className="ra-coef-bar-fill" style={{ height }} data-factor={Number(day.factor) > 1 ? 'up' : 'flat'} />
                  <div className="ra-coef-bar-label">{day.date?.slice(5)}</div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {Array.isArray(explain?.why) && explain.why.length > 0 ? (
        <ol className="ra-why">
          {explain.why.map((step, index) => (
            <li key={`${step.step}-${index}`} className="ra-why-item">
              <div className="ra-why-step">{step.step}</div>
              <div className="ra-why-body">
                <code>{step.expr}</code>
                <div className="ra-why-value">{step.value}</div>
                {step.note ? <div className="ra-hint">{step.note}</div> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {explain?.terms ? (
        <div className="ra-terms">
          {Object.entries(explain.terms).map(([key, value]) => (
            <div key={key} className="ra-term">
              <span className="ra-term-key">{key}</span>
              <span className="ra-term-value">{fmtDec(Number(value), 4)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 草稿产物：回查草稿 → 草稿卡（含审批下拉 → 提交） */
function DraftArtifact({
  artifact,
  approvals,
  onCommitted,
}: {
  artifact: Artifact;
  approvals: Approval[];
  onCommitted?: (order: Order, draft: Draft) => void;
}) {
  const ref = refObject(artifact.ref);
  const draftId = ref.draft_id ? String(ref.draft_id) : '';
  const state = useAsyncData<{ draft: Draft }>(
    (signal) =>
      draftId
        ? apiGet<{ draft: Draft }>(`/drafts/${encodeURIComponent(draftId)}`, undefined, signal)
        : Promise.reject(new Error('产物缺少 draft_id，无法回查')),
    [draftId, artifact.id],
  );

  const related = useMemo(
    () => approvals.filter((item) => !item.draft_id || item.draft_id === draftId),
    [approvals, draftId],
  );

  if (!draftId) return <EmptyState title="草稿产物缺少 draft_id" text="请回到会话重新生成" />;
  if (state.loading && !state.data) return <LoadingBlock text="正在回查草稿…" />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} compact />;
  const draft = state.data?.draft;
  if (!draft) return <EmptyState title="草稿不存在" text="可能已被撤回" />;

  return (
    <div className="ra-artifact">
      <DraftCard draft={draft} pendingApprovals={related} onCommitted={onCommitted} />
    </div>
  );
}

export function ArtifactPanel({ artifacts, approvals, onCommitted }: ArtifactPanelProps) {
  const latest = useMemo(() => {
    const list = [...artifacts].filter(Boolean);
    return list.length > 0 ? list[list.length - 1] : null;
  }, [artifacts]);

  const handleCommitted = useCallback(
    (order: Order, draft: Draft) => {
      onCommitted?.(order, draft);
    },
    [onCommitted],
  );

  if (!latest) {
    return (
      <div className="ra-artifact-empty">
        <EmptyState
          icon="🧾"
          title="还没有产物"
          text="在左侧提问，例如「跑一遍补货建议，列出前 3 个 SKU」。助手调用工具后会在这里生成建议表、解释链或草稿单。"
        />
      </div>
    );
  }

  const body =
    latest.kind === 'suggestions' ? (
      <SuggestionsArtifact artifact={latest} sessionId={null} />
    ) : latest.kind === 'explain' ? (
      <ExplainArtifact artifact={latest} />
    ) : latest.kind === 'draft' ? (
      <DraftArtifact artifact={latest} approvals={approvals} onCommitted={handleCommitted} />
    ) : latest.kind === 'audit' ? (
      <EmptyState icon="🛡️" title="审计产物" text="审计事件请在「审计日志」页查看" />
    ) : (
      <EmptyState icon="📦" title={`产物 ${latest.kind}`} text="该类型尚未注册渲染器（契约 §7）" />
    );

  return <div className="ra-artifact-panel">{body}</div>;
}

export default ArtifactPanel;
