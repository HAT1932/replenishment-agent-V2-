/**
 * ExplainDrawer.tsx — 解释抽屉（逐项 terms / guard / 逐日系数条形图）
 *
 * v1 最大的浪费点：后端算出了 coefficient_detail（逐日系数 + 命中原因），
 * 前端却只显示一个「综合系数」数字。这里必须画出来：
 *   - 每个自然日一根柱：高度=当日系数，颜色=命中原因（双休日/节假日/普通日）
 *   - 图上标出 1.0 基线，柱顶标数值，下方列出 date → reason 的对应关系
 *
 * 数据来源纪律：terms / coefficient_detail / guard 全部取服务端字段；
 * 优先用列表行自带字段，缺失时才回落到 GET /api/sku/:code（并容忍失败）。
 */
import { useMemo } from 'react';
import { Drawer } from '../../components/Drawer';
import { AiExplainPanel } from './AiExplainPanel';
import { CitationStrip } from '../../components/Citation';
import { ProvenanceTag } from '../../components/ProvenanceTag';
import { Sparkline } from '../../components/Sparkline';
import { ErrorState, InlineAlert, LoadingBlock } from '../../components/States';
import { apiGet, errorCode } from '../../lib/api';
import { DASH, fmtDate, fmtDec, fmtInt, fmtMoney, weekdayLabel } from '../../lib/format';
import { useAsyncData } from '../../lib/hooks';
import type { CoefficientDay, ExplainPayload, SkuDetail, Suggestion, SuggestionTerms } from '../../app/types';

export interface ExplainDrawerProps {
  open: boolean;
  suggestion: Suggestion | null;
  onClose: () => void;
}

interface TermRow {
  key: string;
  label: string;
  value: number | undefined;
  hint: string;
  digits: number;
}

/** 计算项展示顺序 + 口径说明（文案来自契约 §2，不含前端计算） */
const TERM_DEFS: Array<{ key: keyof SuggestionTerms; label: string; hint: string; digits: number }> = [
  {
    key: 'avg_daily_sales_exact',
    label: '日均销量（近 15 天）',
    hint: '自然日窗口、缺日补 0；展示值不回代运算（H2 / H7）',
    digits: 4,
  },
  { key: 'coverage_days', label: '可售天数', hint: '方案 1：近 15 天日均销量 × 可售天数', digits: 0 },
  { key: 'purchase_cycle_days', label: '采购周期（天）', hint: '方案 3：两次补货之间的间隔', digits: 0 },
  { key: 'stock_lower_exact', label: '库存预警下限', hint: '固定值，或动态＝最少可售天数 × 日均销量', digits: 2 },
  { key: 'stock_upper_exact', label: '库存预警上限', hint: '固定值，或动态＝最多可售天数 × 日均销量', digits: 2 },
  { key: 'sellable_exact', label: '可售库存', hint: '在库 − 占用（库存第二层）', digits: 2 },
  { key: 'in_transit_exact', label: '在途库存', hint: '已发货未入库（库存第四层）', digits: 2 },
  { key: 'on_hand_exact', label: '实物库存', hint: '在库实物数量（库存第一层）', digits: 2 },
  { key: 'coefficient_exact', label: '综合系数', hint: '到货窗口逐日系数均值（H3）', digits: 4 },
];

function termRows(terms: SuggestionTerms | undefined): TermRow[] {
  if (!terms) return [];
  return TERM_DEFS.filter((def) => terms[def.key] !== undefined && terms[def.key] !== null).map((def) => ({
    key: String(def.key),
    label: def.label,
    value: terms[def.key],
    hint: def.hint,
    digits: def.digits,
  }));
}

/** 服务端精确值展示：最多 4 位小数，去掉无意义的尾随 0（纯格式化） */
function fmtExact(value: number | undefined, digits: number): string {
  if (value === undefined || !Number.isFinite(value)) return DASH;
  if (digits === 0) return fmtInt(value);
  const fixed = value.toFixed(digits);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/** 单日系数原因分类：节假日优先于双休日（与「取较大者」一致） */
function dayKind(day: CoefficientDay): 'holiday' | 'weekend' | 'normal' {
  const reasons = (day.reasons ?? []).join(' ');
  if (/节|holiday|festival/i.test(reasons)) return 'holiday';
  if (/休|weekend|sat|sun/i.test(reasons)) return 'weekend';
  return 'normal';
}

const KIND_COLOR: Record<'holiday' | 'weekend' | 'normal', string> = {
  holiday: 'var(--ra-chart-holiday)',
  weekend: 'var(--ra-chart-weekend)',
  normal: 'var(--ra-chart-neutral)',
};

const KIND_LABEL: Record<'holiday' | 'weekend' | 'normal', string> = {
  holiday: '重大节假日',
  weekend: '双休日',
  normal: '普通工作日',
};

/**
 * 逐日系数条形图：柱高 = 当日系数 / 最大系数，另标 1.0 基线。
 * 纯 SVG，无第三方依赖；日期标签在柱底，命中原因用颜色编码并在下方列出。
 */
function CoefficientChart({ series }: { series: CoefficientDay[] }) {
  if (series.length === 0) {
    return (
      <InlineAlert tone="warn">
        服务端未返回逐日系数明细，无法绘制系数图。请确认该方案是否启用了综合系数。
      </InlineAlert>
    );
  }

  const maxFactor = Math.max(...series.map((day) => (Number.isFinite(day.factor) ? day.factor : 1)), 1);
  const minFactor = Math.min(...series.map((day) => (Number.isFinite(day.factor) ? day.factor : 1)), 1);
  const slotWidth = 34;
  const width = Math.max(320, series.length * slotWidth + 28);
  const height = 132;
  const pad = { l: 26, r: 8, t: 14, b: 26 };
  const innerH = height - pad.t - pad.b;
  const baselineY = pad.t + innerH; // 0 基线

  const scale = (factor: number) => {
    const span = Math.max(maxFactor, 1);
    return (Math.max(0, factor) / span) * innerH;
  };

  const oneY = baselineY - scale(1);

  return (
    <div>
      <svg
        className="ra-coef-chart"
        viewBox={`0 0 ${width} ${height}`}
        style={{ height }}
        role="img"
        aria-label={`逐日综合系数，共 ${series.length} 天，系数范围 ${minFactor} 到 ${maxFactor}`}
      >
        {/* 网格 + 1.0 基线 */}
        {[0, 0.5, 1].map((fraction) => {
          const y = baselineY - fraction * innerH;
          return (
            <line
              key={fraction}
              x1={pad.l}
              y1={y}
              x2={width - pad.r}
              y2={y}
              stroke="var(--ra-chart-grid)"
              strokeWidth="1"
            />
          );
        })}
        <line
          x1={pad.l}
          y1={oneY}
          x2={width - pad.r}
          y2={oneY}
          stroke="var(--ra-info)"
          strokeWidth="1"
          strokeDasharray="4 3"
          opacity="0.6"
        />
        <text x={2} y={oneY + 3} fontSize="8" fill="var(--ra-chart-axis)">
          1.0
        </text>
        <text x={2} y={pad.t + 8} fontSize="8" fill="var(--ra-chart-axis)">
          {maxFactor.toFixed(2)}
        </text>

        {series.map((day, index) => {
          const kind = dayKind(day);
          const barW = Math.min(22, slotWidth - 8);
          const x = pad.l + index * slotWidth + (slotWidth - barW) / 2;
          const factor = Number.isFinite(day.factor) ? day.factor : 1;
          const barH = Math.max(1, scale(factor));
          const y = baselineY - barH;
          return (
            <g key={`${day.date}-${index}`}>
              <rect x={x} y={y} width={barW} height={barH} rx={2} fill={KIND_COLOR[kind]} opacity={kind === 'normal' ? 0.85 : 1} />
              <text
                x={x + barW / 2}
                y={y - 3}
                textAnchor="middle"
                fontSize="8.5"
                fill={kind === 'normal' ? 'var(--ra-chart-axis)' : KIND_COLOR[kind]}
                fontWeight={kind === 'normal' ? 400 : 600}
              >
                {factor.toFixed(2)}
              </text>
              <text x={x + barW / 2} y={height - 12} textAnchor="middle" fontSize="7.5" fill="var(--ra-chart-axis)">
                {day.date?.slice(5) ?? ''}
              </text>
              <text x={x + barW / 2} y={height - 3} textAnchor="middle" fontSize="7.5" fill="var(--ra-chart-axis)">
                {day.weekday !== undefined ? weekdayLabel(day.weekday).slice(1) : ''}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="ra-coef-legend">
        <span>
          <i className="ra-coef-swatch" style={{ background: KIND_COLOR.normal }} /> 普通工作日
        </span>
        <span>
          <i className="ra-coef-swatch" style={{ background: KIND_COLOR.weekend }} /> 双休日
        </span>
        <span>
          <i className="ra-coef-swatch" style={{ background: KIND_COLOR.holiday }} /> 重大节假日
        </span>
      </div>

      <div className="ra-coef-reasons">
        {series.map((day, index) => {
          const kind = dayKind(day);
          const reasons = (day.reasons ?? []).filter(Boolean);
          return (
            <span
              key={`reason-${day.date}-${index}`}
              className="ra-coef-reason"
              data-kind={kind === 'normal' ? undefined : kind}
              data-tip={`${day.date}（${day.weekday !== undefined ? weekdayLabel(day.weekday) : '—'}）${KIND_LABEL[kind]}｜系数 ${day.factor}${
                reasons.length > 0 ? `｜命中：${reasons.join('、')}` : ''
              }`}
            >
              {day.date?.slice(5)} · {day.factor.toFixed(2)}
              {reasons.length > 0 ? ` · ${reasons.join('/')}` : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** 库存四层（下钻，来自 GET /api/sku/:code） */
function InventoryLayers({ detail }: { detail: SkuDetail }) {
  const inv = detail.inventory;
  if (!inv) {
    return <div className="ra-hint">该 SKU 暂无库存快照。</div>;
  }
  const rows: Array<{ label: string; value: number | undefined }> = [
    { label: '实物库存 on_hand', value: inv.on_hand },
    { label: '占用 locked', value: inv.locked },
    { label: '可售库存 sellable', value: inv.sellable ?? inv.sellable_exact },
    { label: '在途库存 in_transit', value: inv.in_transit },
  ];
  return (
    <div className="ra-kv-list">
      {rows.map((row) => (
        <div className="ra-kv" key={row.label}>
          <span className="ra-kv-k">{row.label}</span>
          <span className="ra-kv-v ra-num">{fmtDec(row.value, 2)}</span>
        </div>
      ))}
      <div className="ra-kv">
        <span className="ra-kv-k">快照日期 / 陈旧天数</span>
        <span className="ra-kv-v ra-num">
          {fmtDate(inv.snapshot_date)} / {fmtInt(inv.staleness_days)} 天
          {inv.status ? ` · ${inv.status}` : ''}
        </span>
      </div>
    </div>
  );
}

export function ExplainDrawer({ open, suggestion, onClose }: ExplainDrawerProps) {
  const skuCode = suggestion?.sku_code ?? '';
  const detailState = useAsyncData<SkuDetail>(
    (signal) => apiGet<SkuDetail>(`/sku/${encodeURIComponent(skuCode)}`, undefined, signal),
    [skuCode],
    { enabled: open && skuCode !== '' },
  );

  const detail = detailState.data;
  const explain: ExplainPayload | undefined = detail?.explain;
  const terms = suggestion?.terms ?? explain?.terms;
  const series = suggestion?.coefficient_detail ?? explain?.coefficient_detail ?? [];
  const guard = suggestion?.guard ?? explain?.guard;
  const why = explain?.why ?? [];
  const rows = useMemo(() => termRows(terms), [terms]);

  const salesCurve = useMemo(() => {
    const raw = detail?.sales_90d ?? detail?.curve ?? detail?.sales ?? [];
    return raw
      .filter((point) => typeof point?.date === 'string')
      .map((point) => ({ date: point.date, qty: Number(point.qty) || 0 }));
  }, [detail]);

  if (!suggestion) return null;

  const title = (
    <span className="ra-row ra-gap-3 ra-wrap">
      <span>建议数量解释</span>
      <span className="ra-mono ra-sm ra-muted">{suggestion.sku_code}</span>
      <ProvenanceTag provenance={suggestion.provenance} assumptions={suggestion.assumptions} />
    </span>
  );

  return (
    <Drawer open={open} onClose={onClose} title={title} wide subtitle={suggestion.product_name}>
      <div className="ra-explain">
        <CitationStrip
          compact
          provenance={suggestion.provenance}
          formulaText={suggestion.formula_text ?? explain?.formula_text}
          planName={suggestion.plan_name}
          planType={suggestion.plan_type}
          assumptions={suggestion.assumptions}
          asOf={suggestion.as_of}
          expectedArrival={suggestion.expected_arrival}
        />

        {/* AI 解读：模型用人话解释"为什么这么补"，数字逐句对账 */}
        <AiExplainPanel suggestion={suggestion} />

        {/* 结果区：建议 / 采购 / 金额（全部来自服务端字段） */}
        <dl className="ra-dl">
          <dt>系统建议数量</dt>
          <dd>
            {fmtInt(suggestion.suggest_num)} {suggestion.unit ?? ''}
            <span className="ra-faint ra-xs">（= ceil(原始值 {fmtExact(suggestion.suggest_raw_exact ?? undefined, 4)})，H1）</span>
          </dd>
          <dt>人工采购数量</dt>
          <dd>
            {fmtInt(suggestion.apply_num)} {suggestion.unit ?? ''}
          </dd>
          <dt>单价 / 小计 / 税额</dt>
          <dd>
            {fmtMoney(suggestion.unit_cost)} / {fmtMoney(suggestion.amount)} / {fmtMoney(suggestion.tax_amount)}
          </dd>
          <dt>预计到货 / 计算日</dt>
          <dd>
            {fmtDate(suggestion.expected_arrival)} / {fmtDate(suggestion.as_of)}
          </dd>
        </dl>

        {/* terms 逐项 */}
        <section>
          <div className="ra-section-title ra-mb-3">计算项 terms（值 + 口径）</div>
          {rows.length === 0 ? (
            <div className="ra-hint">服务端未返回计算项明细。</div>
          ) : (
            <div className="ra-terms">
              {rows.map((row) => (
                <div className="ra-term" key={row.key}>
                  <span className="ra-term-k">{row.label}</span>
                  <span className="ra-term-v">{fmtExact(row.value, row.digits)}</span>
                  <span className="ra-term-e">{row.hint}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 逐日系数（v1 缺失的核心图） */}
        <section>
          <div className="ra-section-title ra-mb-3">
            逐日综合系数
            <span className="ra-chip">
              窗口 {series.length} 天 · 均值 {fmtExact(suggestion.coefficient_exact ?? undefined, 4)}
            </span>
          </div>
          <div className="ra-coef">
            <div className="ra-coef-head">
              <span className="ra-hint">
                系数窗口 = [预计到货日, 到货日 + 周期 − 1] 闭区间；同日命中多个取较大者（H3）
              </span>
            </div>
            <CoefficientChart series={series} />
          </div>
        </section>

        {/* 低库存闸门 */}
        <section>
          <div className="ra-section-title ra-mb-3">低库存闸门 guard</div>
          {guard ? (
            <div className="ra-guard" data-passed={guard.passed === false ? 'false' : 'true'}>
              <div className="ra-row ra-gap-3">
                <span className={`ra-tag ${guard.passed === false ? 'ra-tag-danger' : 'ra-tag-ok'}`}>
                  {guard.passed === false ? '未通过（不产生建议）' : '通过'}
                </span>
                {guard.policy ? <span className="ra-chip">口径 {guard.policy}</span> : null}
              </div>
              {guard.text ? <div className="ra-guard-text">{guard.text}</div> : null}
              {guard.expressions && guard.expressions.length > 0 ? (
                <div className="ra-guard-exprs">
                  {guard.expressions.map((expr, index) => (
                    <code key={`${expr}-${index}`}>{expr}</code>
                  ))}
                </div>
              ) : null}
              <div className="ra-hint">
                官方两篇文档对「实物+在途」的判定口径存在冲突（H4），此处展示服务端实际采用的口径。
              </div>
            </div>
          ) : (
            <div className="ra-hint">服务端未返回闸门信息。</div>
          )}
        </section>

        {/* 推导步骤（why） */}
        <section>
          <div className="ra-section-title ra-mb-3">推导步骤 why（服务端逐步骤表达式）</div>
          {why.length === 0 ? (
            <div className="ra-hint">
              未获取到逐步推导明细（SKU 详情未返回推导步骤）。
              {detailState.error ? `（${detailState.error}）` : ''}
            </div>
          ) : (
            <div className="ra-why">
              {why.map((step, index) => (
                <div className="ra-why-step" key={`${String(step.step ?? index)}-${index}`}>
                  <span className="ra-why-idx">#{String(step.step ?? index + 1)}</span>
                  <span className="ra-why-body">
                    {step.expr ? <code className="ra-why-expr">{step.expr}</code> : null}
                    <span className="ra-row ra-gap-3 ra-wrap">
                      {step.value !== undefined ? <span className="ra-why-value">= {String(step.value)}</span> : null}
                      {step.note ? <span className="ra-why-note">{step.note}</span> : null}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 下钻：库存四层 + 90 天曲线 + 各方案对比 */}
        <section>
          <div className="ra-section-title ra-mb-3">
            SKU 下钻（库存四层 / 90 天曲线 / 各方案建议）
            {detailState.loading ? <span className="ra-spinner" aria-hidden="true" /> : null}
          </div>

          {detailState.error ? (
            <ErrorState
              compact
              message={detailState.error}
              code={errorCode(detailState.error)}
              onRetry={detailState.reload}
            />
          ) : detailState.loading && !detail ? (
            <LoadingBlock text="正在加载 SKU 详情…" />
          ) : detail ? (
            <div className="ra-col ra-gap-4">
              <InventoryLayers detail={detail} />

              <div>
                <div className="ra-hint ra-mb-3">销量曲线（服务端 90 天数据）</div>
                <Sparkline data={salesCurve} height={84} emptyText="服务端未返回销量曲线" />
              </div>

              {detail.suggestions && detail.suggestions.length > 0 ? (
                <div>
                  <div className="ra-hint ra-mb-3">同一 SKU 在各方案下的建议</div>
                  <div className="ra-terms">
                    {detail.suggestions.map((item, index) => (
                      <div className="ra-term" key={`${item.plan_id ?? 'plan'}-${index}`}>
                        <span className="ra-term-k">{item.plan_name ?? item.plan_id ?? `方案 ${index + 1}`}</span>
                        <span className="ra-term-v">{fmtInt(item.suggest_num)}</span>
                        <span className="ra-term-e">
                          {item.provenance === 'documented' ? '官方口径' : item.provenance === 'enhancement' ? '增强' : '假设'} ·
                          raw {fmtExact(item.suggest_raw_exact ?? undefined, 4)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </Drawer>
  );
}
