/**
 * WorkbenchPage.tsx — 补货工作台（决策支持）
 * ---------------------------------------------------------------------------
 * 回答三个问题（按顺序）：
 *   1) 谁最危险？—— 风险分级（缺货/紧急/建议/滞销/充足）+ 可售天数 + 预计断货日
 *   2) 钱压在哪？—— 库存资金占用（实物 × 成本价）
 *   3) 下一步做什么？—— 勾选 → 一键转草稿（只产草稿，提交仍需审批）
 *
 * 可信边界（页面级 CitationStrip 明示）：
 *   - 建议数量：**官方文档口径**（documented，来自 domain）
 *   - 风险分级 / 可售天数 / 断货日 / 资金占用：**本实现增强**（enhancement，无官方依据）
 */
import { useMemo, useState } from 'react';
import { apiGet, apiPost, errorMessage } from '../../lib/api';
import { useAsyncData, useDebounced } from '../../lib/hooks';
import { DASH, fmtInt, fmtMoney } from '../../lib/format';
import { Kpi, KpiRow } from '../../components/Kpi';
import { CitationStrip } from '../../components/Citation';
import { DataTable, type Column } from '../../components/DataTable';
import { Pager } from '../../components/Pager';
import { EmptyState, ErrorState, InlineAlert, LoadingBlock } from '../../components/States';
import { useToast } from '../../components/Toast';
import { navigate } from '../../app/router';
import type { Plan } from '../../app/types';
import type { RiskLevel, WorkbenchResponse, WorkbenchRow } from '../../app/workbench-types';

const RISK_TONE: Record<string, string> = {
  缺货: 'ra-tag-danger',
  紧急: 'ra-tag-warn',
  建议: 'ra-tag-info',
  滞销: 'ra-tag-purple',
  充足: 'ra-tag-ok',
};

const RISK_HINT: Record<string, string> = {
  缺货: '可售+在途为 0，已断货',
  紧急: '需要补货且可售天数 ≤ 3 天',
  建议: '触发低库存预警，需要补货',
  滞销: '低销且可售天数 ≥ 90 天（占用资金）',
  充足: '库存充足，未触发预警',
};

function RiskTag({ level }: { level: RiskLevel | string }) {
  return (
    <span className={`ra-tag ${RISK_TONE[level] ?? 'ra-tag-gray'}`} title={RISK_HINT[level] ?? ''}>
      {level}
    </span>
  );
}

export function WorkbenchPage() {
  const toast = useToast();
  const [planId, setPlanId] = useState<string>('');
  const [risk, setRisk] = useState<string>('');
  const [keywordInput, setKeywordInput] = useState('');
  const keyword = useDebounced(keywordInput, 320);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const plansState = useAsyncData<{ plans: Plan[] }>(
    (signal) => apiGet<{ plans: Plan[] }>('/plans', undefined, signal),
    [],
  );

  const query = useMemo(
    () => ({
      ...(planId ? { plan_id: planId } : {}),
      ...(risk ? { risk } : {}),
      ...(keyword ? { keyword } : {}),
      page,
      page_size: pageSize,
    }),
    [planId, risk, keyword, page, pageSize],
  );

  const state = useAsyncData<WorkbenchResponse>(
    (signal) => apiGet<WorkbenchResponse>('/workbench', query, signal),
    [JSON.stringify(query)],
  );

  const data = state.data;
  const rows = data?.rows ?? [];
  const kpi = data?.kpi;

  const resetPage = () => {
    setPage(1);
    setSelected(new Set());
  };

  const toggleRisk = (level: string) => {
    setRisk((current) => (current === level ? '' : level));
    resetPage();
  };

  const selectedRows = rows.filter((row) => selected.has(row.sku_code));

  async function createDraftFromSelection() {
    if (selectedRows.length === 0) return;
    setCreating(true);
    try {
      const payload = {
        kind: 'purchase',
        items: selectedRows.map((row) => ({ sku_code: row.sku_code, apply_num: row.suggest_num })),
        remark: `工作台批量生成（${selectedRows.length} 个 SKU，方案 ${data?.plan.plan_name ?? ''}）`,
        created_by: 'human',
      };
      const created = await apiPost<{ draft: { draft_id?: string; id?: string } }>('/drafts', payload);
      const draftId = created?.draft?.draft_id ?? created?.draft?.id ?? '';
      toast(`已生成草稿${draftId ? ` ${draftId.slice(0, 12)}` : ''}（${selectedRows.length} 行）。草稿不会自动提交，需人工审批。`, 'ok');
      setSelected(new Set());
      navigate('/drafts');
    } catch (err) {
      toast(`生成草稿失败：${errorMessage(err)}`, 'err');
    } finally {
      setCreating(false);
    }
  }

  const columns: Column<WorkbenchRow>[] = [
    {
      key: 'risk',
      header: '风险',
      width: 76,
      sortable: true,
      sortValue: (row) => row.risk_priority,
      render: (row) => <RiskTag level={row.risk_level} />,
    },
    {
      key: 'product',
      header: '商品',
      render: (row) => (
        <div>
          <button
            type="button"
            className="ra-link"
            onClick={() => navigate(`/sku/${encodeURIComponent(row.sku_code)}`)}
            title="打开 SKU 详情（库存四层 / 90 天曲线 / 各方案对照 / 解释链）"
          >
            {row.product_name}
          </button>
          <div className="ra-cell-sub">
            {row.sku_code} · {row.spec || DASH} · {row.unit || DASH}
          </div>
        </div>
      ),
    },
    {
      key: 'stock',
      header: '可售',
      subHeader: '在途 / 实物',
      align: 'right',
      render: (row) => (
        <span title={`可售 ${row.sellable_stock} / 在途 ${row.in_transit_stock} / 实物 ${row.on_hand_stock}`}>
          <div className={row.sellable_stock < 0 ? 'ra-num-negative' : undefined}>{fmtInt(row.sellable_stock)}</div>
          <div className="ra-cell-sub">
            {fmtInt(row.in_transit_stock)} / {fmtInt(row.on_hand_stock)}
          </div>
        </span>
      ),
    },
    {
      key: 'avg',
      header: '日均销量',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.avg_daily_sales,
      render: (row) => row.avg_daily_sales.toFixed(4),
    },
    {
      key: 'cover',
      header: '可售天数',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.cover_days ?? Number.MAX_SAFE_INTEGER,
      render: (row) =>
        row.cover_days === null ? (
          <span title="无销量，可售天数无穷大">{DASH}</span>
        ) : (
          <span className={row.cover_days <= 3 ? 'ra-num-danger' : undefined}>{row.cover_days}</span>
        ),
    },
    {
      key: 'stockout',
      header: '预计断货',
      align: 'right',
      render: (row) => (row.stockout_date ? row.stockout_date.slice(5) : '不会断货'),
    },
    {
      key: 'suggest',
      header: '建议补货',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.suggest_num,
      render: (row) => <span className="ra-num-readonly">{fmtInt(row.suggest_num)}</span>,
    },
    {
      key: 'capital',
      header: '库存资金',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.inventory_capital,
      render: (row) => fmtMoney(row.inventory_capital),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'center',
      width: 70,
      render: (row) => (
        <button
          type="button"
          className="ra-btn ra-btn-sm"
          onClick={() => navigate(`/sku/${encodeURIComponent(row.sku_code)}`)}
        >
          详情
        </button>
      ),
    },
  ];

  return (
    <div className="ra-page">
      <div className="ra-page-head">
        <div>
          <h2 className="ra-page-title">补货工作台</h2>
          <p className="ra-hint">
            先看谁危险，再看钱压在哪。风险分级/可售天数/断货日/资金占用属于<strong>本实现增强</strong>；建议数量仍是官方文档口径。
          </p>
        </div>
        <div className="ra-page-actions">
          <button
            type="button"
            className="ra-btn ra-btn-primary"
            disabled={selectedRows.length === 0 || creating}
            onClick={() => void createDraftFromSelection()}
            title="把勾选的 SKU 按建议数量生成草稿（只产草稿，提交需审批）"
          >
            {creating ? '生成中…' : `生成草稿（${selectedRows.length}）`}
          </button>
          <button type="button" className="ra-btn ra-btn-ghost" onClick={state.reload} disabled={state.loading}>
            刷新
          </button>
        </div>
      </div>

      {data ? (
        <CitationStrip
          compact
          provenance={data.plan.provenance}
          formulaText={data.plan.formula_text}
          planName={data.plan.plan_name}
          planType={data.plan.plan_type}
          guardNote={data.citation?.disclaimer}
          asOf={data.as_of}
          expectedArrival={data.expected_arrival}
        />
      ) : null}

      <div className="ra-toolbar">
        <label className="ra-field">
          <span>补货方案</span>
          <select
            className="ra-select"
            value={planId}
            onChange={(event) => {
              setPlanId(event.target.value);
              resetPage();
            }}
          >
            <option value="">默认方案</option>
            {(plansState.data?.plans ?? []).map((plan) => (
              <option key={String(plan.plan_id)} value={String(plan.plan_id)}>
                {plan.plan_name}
              </option>
            ))}
          </select>
        </label>

        <label className="ra-field">
          <span>商品筛选</span>
          <input
            className="ra-input"
            placeholder="名称 / 编码"
            value={keywordInput}
            onChange={(event) => {
              setKeywordInput(event.target.value);
              resetPage();
            }}
          />
        </label>

        <div className="ra-field">
          <span>风险筛选</span>
          <div className="ra-chip-group">
            {(data?.risk_levels ?? ['缺货', '紧急', '建议', '滞销', '充足']).map((level) => (
              <button
                key={level}
                type="button"
                className={`ra-chip${risk === level ? ' ra-chip-active' : ''}`}
                onClick={() => toggleRisk(level)}
                title={RISK_HINT[level] ?? ''}
              >
                {level}
                {kpi ? (
                  <span className="ra-chip-count">
                    {level === '缺货'
                      ? kpi.stockout_count
                      : level === '紧急'
                        ? kpi.urgent_count
                        : level === '建议'
                          ? kpi.suggest_count
                          : level === '滞销'
                            ? kpi.slow_moving_count
                            : kpi.sufficient_count}
                  </span>
                ) : null}
              </button>
            ))}
            {risk ? (
              <button type="button" className="ra-btn ra-btn-ghost ra-btn-sm" onClick={() => toggleRisk(risk)}>
                清除
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {kpi ? (
        <KpiRow>
          <Kpi
            label="缺货 / 紧急"
            value={
              <>
                <span className="ra-num-danger">{fmtInt(kpi.stockout_count)}</span>
                <span className="ra-kpi-sep"> / </span>
                {fmtInt(kpi.urgent_count)}
              </>
            }
            unit="个"
            foot="可售+在途为 0 / 可售天数 ≤ 3"
            tone={kpi.stockout_count > 0 ? 'danger' : kpi.urgent_count > 0 ? 'warn' : undefined}
            hint="来源：服务端 kpi.stockout_count / kpi.urgent_count"
          />
          <Kpi
            label="需补货"
            value={fmtInt(kpi.suggest_count + kpi.urgent_count + kpi.stockout_count)}
            unit="个"
            foot={`低库存预警 ${fmtInt(kpi.low_stock_alert_count)} 个`}
            hint="来源：服务端 kpi（建议+紧急+缺货）"
          />
          <Kpi
            label="7 天内断货"
            value={fmtInt(kpi.stockout_within_7d_count)}
            unit="个"
            foot="按当前日均推算"
            tone={kpi.stockout_within_7d_count > 0 ? 'warn' : undefined}
            hint="来源：服务端 kpi.stockout_within_7d_count"
          />
          <Kpi
            label="滞销占用"
            value={fmtInt(kpi.slow_moving_count)}
            unit="个"
            foot="低销 + 可售 ≥ 90 天"
            hint="来源：服务端 kpi.slow_moving_count"
          />
          <Kpi
            label="建议补货量"
            value={fmtInt(kpi.total_suggest_num)}
            unit="件"
            foot={fmtMoney(kpi.total_amount)}
            hint="来源：服务端 kpi.total_suggest_num / total_amount（documented 口径）"
          />
          <Kpi
            label="库存资金"
            value={fmtMoney(kpi.inventory_capital)}
            foot="实物 × 成本价（增强指标）"
            hint="来源：服务端 kpi.inventory_capital"
          />
          <Kpi
            label="平均可售天数"
            value={kpi.avg_cover_days === null ? DASH : kpi.avg_cover_days}
            unit="天"
            foot={`${fmtInt(kpi.row_count)} 个 SKU · 过期 ${fmtInt(kpi.stale_count)}`}
            hint="来源：服务端 kpi.avg_cover_days（有限值平均）"
          />
        </KpiRow>
      ) : null}

      {state.error ? (
        <ErrorState message={state.error} onRetry={state.reload} />
      ) : state.loading && !data ? (
        <LoadingBlock text="正在计算风险视图…" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="🧭"
          title={risk ? `没有「${risk}」的 SKU` : '没有可展示的 SKU'}
          text="试试清除筛选，或换一个补货方案。"
          actions={
            risk ? (
              <button type="button" className="ra-btn" onClick={() => toggleRisk(risk)}>
                清除筛选
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(row) => row.sku_code}
            selectable
            selectedKeys={selected}
            onSelectionChange={setSelected}
            defaultSort={{ key: 'risk', dir: 'asc' }}
            rowClassName={(row) => (row.risk_level === '缺货' ? 'ra-row-danger' : undefined)}
            caption="补货工作台：按风险优先级排序；可勾选后一键生成草稿"
            minWidth={1080}
          />
          <Pager
            page={data?.page ?? 1}
            pageSize={data?.page_size ?? pageSize}
            total={data?.total ?? rows.length}
            totalPages={data?.total_pages}
            onPage={(next) => setPage(next)}
            onPageSize={(size) => {
              setPageSize(size);
              resetPage();
            }}
          />
          {data?.skipped && data.skipped.length > 0 ? (
            <InlineAlert tone="warn">
              有 {data.skipped.length} 个 SKU 无法计算（{data.skipped[0].code}：{data.skipped[0].message}
              {data.skipped.length > 1 ? ' 等' : ''}）。这些 SKU 不会被静默当成 0 库存处理。
            </InlineAlert>
          ) : null}
        </>
      )}
    </div>
  );
}

export default WorkbenchPage;
