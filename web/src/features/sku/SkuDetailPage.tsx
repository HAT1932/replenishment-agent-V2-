/**
 * SkuDetailPage.tsx — 单 SKU 决策下钻（v1 四层下钻在 v2 的正式落点）
 * ---------------------------------------------------------------------------
 * 四层，从上到下回答四个问题：
 *   ① 事实层：库存四层（实物/占用/可售/在途）+ 预警上下限 + 日均（含缺日补零说明）
 *   ② 趋势层：近 90 天出库曲线（Sparkline）+ 近 15 天窗口（缺几日、最后记录日）
 *   ③ 方案对照层：4 个方案各算出的建议数量并排（同一 SKU、同一数据日期）
 *   ④ 解释层：terms 逐项数值 / 逐日综合系数 / 闸门 / 分步推导（why）
 * 另附「参数来源」：方案参数、库存预警配置、命中的假设（H1–H10 可点开）。
 */
import { useMemo, useState } from 'react';
import { apiGet, apiPost, errorMessage } from '../../lib/api';
import { useAsyncData } from '../../lib/hooks';
import { DASH, fmtDate, fmtInt, fmtMoney, weekdayLabel } from '../../lib/format';
import { Sparkline } from '../../components/Sparkline';
import { Kpi, KpiRow } from '../../components/Kpi';
import { CitationStrip } from '../../components/Citation';
import { ProvenanceTag } from '../../components/ProvenanceTag';
import { DataTable, type Column } from '../../components/DataTable';
import { EmptyState, ErrorState, InlineAlert, LoadingBlock } from '../../components/States';
import { useToast } from '../../components/Toast';
import { navigate } from '../../app/router';
import type { CoefficientDay, SkuDetail, Suggestion, WhyStep } from '../../app/types';
import type { SkuDecision } from '../../app/workbench-types';

/** 服务端实际返回比早期类型更全：这里补视图类型，不改公共 types.ts */
type SkuDetailView = SkuDetail & {
  as_of?: string;
  series?: Array<{ date: string; qty: number }>;
  errors?: Array<{ plan_id?: string; code: string; message: string }>;
  decision?: SkuDecision | null;
};

type DemandWindowView = {
  as_of?: string;
  days?: number;
  scope?: string;
  include?: string[];
  total?: number;
  recorded_days?: number;
  imputed_days?: number;
  last_recorded_date?: string | null;
  staleness_days?: number;
  status?: string;
};

type SuggestionView = Suggestion & {
  demand_window?: DemandWindowView;
  suggest_raw?: number;
  coefficient_enabled?: boolean;
  coefficient?: number;
  why?: WhyStep[];
  guard?: (Suggestion['guard'] & { alert?: boolean }) | null;
};

const RISK_TONE: Record<string, string> = {
  缺货: 'ra-tag-danger',
  紧急: 'ra-tag-warn',
  建议: 'ra-tag-info',
  滞销: 'ra-tag-purple',
  充足: 'ra-tag-ok',
};

function Section({ title, subtitle, children, actions }: { title: string; subtitle?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="ra-card ra-section">
      <div className="ra-section-head">
        <div>
          <h3 className="ra-section-title">{title}</h3>
          {subtitle ? <p className="ra-hint">{subtitle}</p> : null}
        </div>
        {actions ? <div className="ra-section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function CoefficientBars({ days }: { days: CoefficientDay[] }) {
  if (!days.length) return <p className="ra-hint">该方案未启用综合系数（系数恒为 1）。</p>;
  const max = Math.max(...days.map((day) => Number(day.factor) || 1), 1.2);
  return (
    <div className="ra-coef">
      <div className="ra-coef-bars">
        {days.map((day) => {
          const height = Math.max(6, (Number(day.factor) / max) * 64);
          return (
            <div
              key={day.date}
              className="ra-coef-bar"
              title={`${day.date} ${weekdayLabel(day.weekday ?? 0)} ×${day.factor} ${(day.reasons ?? []).join('/')}`}
            >
              <div className="ra-coef-bar-fill" style={{ height }} data-factor={Number(day.factor) > 1 ? 'up' : 'flat'} />
              <div className="ra-coef-bar-label">{day.date.slice(5)}</div>
            </div>
          );
        })}
      </div>
      <p className="ra-hint">
        系数 = Σ(每日系数) / {days.length} 天 = {days.length ? (days.reduce((sum, d) => sum + (Number(d.factor) || 1), 0) / days.length).toFixed(4) : DASH}
        （周末/节假日加权按方案参数，见假设 H3）
      </p>
    </div>
  );
}

function WhySteps({ steps }: { steps: WhyStep[] }) {
  if (!steps.length) return <p className="ra-hint">该行没有解释链（可能来自 σ 方案）。</p>;
  return (
    <ol className="ra-why">
      {steps.map((step, index) => (
        <li key={`${step.step}-${index}`} className="ra-why-item">
          <div className="ra-why-step">{step.step}</div>
          <div className="ra-why-body">
            <code>{step.expr}</code>
            <div className="ra-why-value">{String(step.value ?? '')}</div>
            {step.note ? <div className="ra-hint">{step.note}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function SkuDetailPage({ skuCode }: { skuCode: string | null }) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const state = useAsyncData<SkuDetailView>(
    (signal) => (skuCode ? apiGet<SkuDetail>(`/sku/${encodeURIComponent(skuCode)}`, undefined, signal) : Promise.reject(new Error('缺少 SKU 编码'))),
    [skuCode],
  );

  const detail = state.data;
  const suggestions = (detail?.suggestions ?? []) as SuggestionView[];
  const sku = detail?.sku;
  const decision = detail?.decision ?? null;
  const documented: SuggestionView | undefined = useMemo(
    () => suggestions.find((item) => item.provenance === 'documented') ?? suggestions[0],
    [suggestions],
  );
  const explain = detail?.explain;
  const demandWindow = documented?.demand_window;

  async function createDraft() {
    if (!documented) return;
    setCreating(true);
    try {
      const created = await apiPost<{ draft: { draft_id?: string; id?: string } }>('/drafts', {
        kind: 'purchase',
        items: [{ sku_code: documented.sku_code, apply_num: documented.suggest_num }],
        remark: `SKU 详情页生成草稿（${documented.plan_name ?? ''}）`,
        created_by: 'human',
      });
      const draftId = created?.draft?.draft_id ?? created?.draft?.id ?? '';
      toast(`已生成草稿${draftId ? ` ${draftId.slice(0, 12)}` : ''}，需人工审批后提交。`, 'ok');
      navigate('/drafts');
    } catch (err) {
      toast(`生成草稿失败：${errorMessage(err)}`, 'err');
    } finally {
      setCreating(false);
    }
  }

  if (!skuCode) {
    return (
      <EmptyState
        icon="🔎"
        title="缺少 SKU 编码"
        text="请从补货建议或工作台点击「详情」进入。"
        actions={<button type="button" className="ra-btn" onClick={() => navigate('/suggestions')}>去补货建议</button>}
      />
    );
  }
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (state.loading && !detail) return <LoadingBlock text="正在加载 SKU 详情…" />;
  if (!sku) return <EmptyState icon="📦" title="SKU 不存在" text={`未找到 ${skuCode}`} />;

  const planColumns: Column<SuggestionView>[] = [
    {
      key: 'plan',
      header: '方案',
      render: (row) => (
        <div>
          <div>{row.plan_name || DASH}</div>
          <div className="ra-cell-sub">{row.plan_type}</div>
        </div>
      ),
    },
    { key: 'formula', header: '口径', render: (row) => <span className="ra-formula-text">{row.formula_text}</span> },
    { key: 'prov', header: '溯源', align: 'center', width: 96, render: (row) => <ProvenanceTag provenance={row.provenance} /> },
    {
      key: 'suggest',
      header: '建议数量',
      align: 'right',
      render: (row) => (
        <span className="ra-num-readonly" title={`raw=${row.suggest_raw}`}>
          {fmtInt(row.suggest_num)}
        </span>
      ),
    },
    {
      key: 'coef',
      header: '综合系数',
      align: 'right',
      render: (row) => (row.coefficient_enabled ? Number(row.coefficient).toFixed(4) : '1'),
    },
    {
      key: 'guard',
      header: '闸门',
      align: 'center',
      render: (row) =>
        row.guard?.alert ? <span className="ra-tag ra-tag-warn">通过</span> : <span className="ra-tag ra-tag-gray">未触发</span>,
    },
    { key: 'amount', header: '金额', align: 'right', render: (row) => fmtMoney(row.amount) },
  ];

  return (
    <div className="ra-page">
      <div className="ra-page-head">
        <div>
          <button type="button" className="ra-btn ra-btn-ghost ra-btn-sm" onClick={() => globalThis.history.back()}>
            ← 返回
          </button>
          <h2 className="ra-page-title">
            {sku.product_name}
            {decision ? (
              <span className={`ra-tag ${RISK_TONE[decision.risk.level] ?? 'ra-tag-gray'}`} style={{ marginLeft: 8 }}>
                {decision.risk.level}
              </span>
            ) : null}
          </h2>
          <p className="ra-hint">
            {sku.sku_code} · {sku.sku_no} · {sku.spec} · {sku.unit} · {sku.category} · {sku.store_name} · 供应商 {sku.supplier_name || DASH}
          </p>
        </div>
        <div className="ra-page-actions">
          <button type="button" className="ra-btn ra-btn-primary" disabled={creating || !documented} onClick={() => void createDraft()}>
            {creating ? '生成中…' : '生成草稿'}
          </button>
          <button type="button" className="ra-btn ra-btn-ghost" onClick={state.reload} disabled={state.loading}>
            刷新
          </button>
        </div>
      </div>

      {documented ? (
        <CitationStrip
          provenance={documented.provenance}
          formulaText={documented.formula_text}
          planName={documented.plan_name}
          planType={documented.plan_type}
          assumptions={documented.assumptions}
          guardNote={documented.guard?.text}
          asOf={detail?.as_of}
          expectedArrival={documented.expected_arrival}
        />
      ) : null}

      {state.error ? <InlineAlert tone="warn">{state.error}</InlineAlert> : null}

      {/* ① 事实层 */}
      <Section
        title="① 事实层：库存与预警"
        subtitle="可售 = 实物 − 占用；闸门口径默认「实物 + 在途 < 预警下限」（假设 H4）"
      >
        <KpiRow>
          <Kpi label="实物库存" value={fmtInt(detail?.inventory?.on_hand ?? 0)} unit={sku.unit} hint="来源：inventory.on_hand" />
          <Kpi label="占用" value={fmtInt(detail?.inventory?.locked ?? 0)} unit={sku.unit} hint="来源：inventory.locked（未出库的占用）" />
          <Kpi
            label="可售"
            value={fmtInt(detail?.inventory?.sellable ?? 0)}
            unit={sku.unit}
            tone={(detail?.inventory?.sellable ?? 0) < 0 ? 'danger' : undefined}
            hint="来源：服务端 inventory.sellable（超卖会是负数，不裁剪）"
          />
          <Kpi label="在途" value={fmtInt(detail?.inventory?.in_transit ?? 0)} unit={sku.unit} hint="来源：inventory.in_transit" />
          <Kpi label="预警下限" value={fmtInt(documented?.stock_lower ?? 0)} unit={sku.unit} foot="实物+在途 < 下限 → 触发" />
          <Kpi label="库存上限" value={fmtInt(documented?.stock_upper ?? 0)} unit={sku.unit} foot="方案 2 的补货目标值" />
          <Kpi
            label="可售天数"
            value={decision?.risk.cover_days === null || decision?.risk.cover_days === undefined ? DASH : decision.risk.cover_days}
            unit="天"
            foot={decision?.risk.stockout_date ? `预计断货 ${fmtDate(decision.risk.stockout_date)}` : '按当前日均不会断货'}
            hint="增强指标（enhancement）"
          />
        </KpiRow>
        {decision ? (
          <div className="ra-explain-guard" data-alert={decision.risk.level === '充足' ? 'true' : 'false'}>
            <span className="ra-tag ra-tag-gray">增强</span>
            <span>
              风险判定：{decision.risk.reasons.join('；')}（可售天数阈值 {decision.risk.strategy?.urgent_cover_days ?? 3} 天，无官方文档依据）
            </span>
          </div>
        ) : null}
        {detail?.inventory?.staleness_days ? (
          <InlineAlert tone="warn">
            库存快照已过期 {detail.inventory.staleness_days} 天（{detail.inventory.snapshot_date}）；过期数据不会进入自动草稿。
          </InlineAlert>
        ) : null}
      </Section>

      {/* ② 趋势层 */}
      <Section title="② 趋势层：近 90 天出库" subtitle="缺日按 0 计（不是跳过）；日均 = 窗口内总量 / 自然日数">
        <Sparkline data={(detail?.series ?? []).map((point) => ({ date: point.date, qty: point.qty }))} height={96} label="日销量" />
        {demandWindow ? (
          <div className="ra-window-meta">
            <span className="ra-tag ra-tag-info">近 {demandWindow.days} 天窗口</span>
            <span>
              合计 {fmtInt(demandWindow.total ?? 0)} 件 / {demandWindow.days} 天 ={' '}
              <strong>{Number(documented?.avg_daily_sales ?? 0).toFixed(4)}</strong> 件/天
            </span>
            <span className="ra-hint">
              有记录 {demandWindow.recorded_days ?? DASH} 天 · 补零 {demandWindow.imputed_days ?? 0} 天 · 最后记录{' '}
              {demandWindow.last_recorded_date ?? DASH} · 口径 {demandWindow.include?.join('+') ?? 'sale'}
            </span>
          </div>
        ) : null}
      </Section>

      {/* ③ 方案对照层 */}
      <Section
        title="③ 方案对照：同一 SKU、同一数据日期下 4 个方案"
        subtitle="数量不同不是 bug，是口径不同；每个方案都标了 provenance"
      >
        {suggestions.length > 0 ? (
          <DataTable
            rows={suggestions}
            columns={planColumns}
            rowKey={(row) => String(row.plan_id ?? row.plan_name)}
            dense
            caption="同一 SKU 在各方案下的建议数量对照"
            rowClassName={(row) => (row.provenance === 'enhancement' ? 'ra-row-enhancement' : undefined)}
            minWidth={880}
          />
        ) : (
          <EmptyState title="没有可用方案" text="检查方案配置或该 SKU 的库存快照。" />
        )}
      </Section>

      {/* ④ 解释层 */}
      <Section title="④ 解释层：建议数量是怎么算出来的" subtitle={documented?.formula_text}>
        {explain?.guard ? (
          <div className="ra-explain-guard" data-alert={explain.guard.passed ? 'true' : 'false'}>
            <span className="ra-tag">{explain.guard.policy ?? '闸门'}</span>
            <span>{explain.guard.text ?? DASH}</span>
          </div>
        ) : null}

        <div className="ra-terms">
          {Object.entries(explain?.terms ?? {}).map(([key, value]) => (
            <div key={key} className="ra-term">
              <span className="ra-term-key">{key}</span>
              <span className="ra-term-value">{typeof value === 'number' ? value.toFixed(4) : String(value)}</span>
            </div>
          ))}
        </div>

        <CoefficientBars days={explain?.coefficient_detail ?? []} />
        <WhySteps steps={explain?.why ?? documented?.why ?? []} />
      </Section>

      {/* 参数来源 */}
      <Section title="参数来源：改一个数会改什么" subtitle="方案参数 / 库存预警配置 / 命中假设，全部可追溯到代码与假设编号">
        <div className="ra-param-grid">
          <div>
            <div className="ra-param-title">方案参数（{documented?.plan_name ?? DASH}）</div>
            <pre className="ra-json">{JSON.stringify(documented?.terms ?? {}, null, 2)}</pre>
          </div>
          <div>
            <div className="ra-param-title">命中的假设</div>
            <ul className="ra-assumption-list">
              {(documented?.assumptions ?? []).map((id) => (
                <li key={id}>
                  <button type="button" className="ra-link" onClick={() => navigate('/assumptions')}>
                    {id}
                  </button>
                </li>
              ))}
              {(documented?.assumptions ?? []).length === 0 ? <li className="ra-hint">无</li> : null}
            </ul>
            <div className="ra-param-title" style={{ marginTop: 10 }}>数据日期</div>
            <div>{detail?.as_of ?? DASH}（来自 meta.seed_end_date，不读系统时钟）</div>
          </div>
        </div>
      </Section>
    </div>
  );
}

export default SkuDetailPage;
