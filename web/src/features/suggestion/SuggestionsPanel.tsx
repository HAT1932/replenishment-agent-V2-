/**
 * SuggestionsPanel.tsx — 补货建议表（v1 范式迁移 · 契约 §7 必带 1/2/3/5）
 *
 * 硬性还原点：
 *  1) 9 列同序：商品名称 | 单位 | 库存上限(上下限双行) | 日均销量 | 可售库存 | 在途库存 | 建议数量 | 采购数量 | 操作
 *  2) 建议数量**只读**、采购数量**可编辑**，偏离时显示 Δ 徽标（+12 / −5）→「系统建议 → 人工确认」护栏
 *  3) 勾选 / 全选 / 底部合计（数量 + 金额）/ 生成草稿
 *  4) Citation strip（documented / enhancement / assumption 三态）
 *  5) KPI 只用服务端 `kpi`，**前端绝不自行聚合**
 *  6) 表格四态 + 排序 + 分页 + CSV 导出（接口存在才显示）
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DataTable } from '../../components/DataTable';
import type { Column, SortState } from '../../components/DataTable';
import { CitationStrip } from '../../components/Citation';
import { Kpi, KpiRow } from '../../components/Kpi';
import { Pager } from '../../components/Pager';
import { ErrorState, InlineAlert, LoadingBlock } from '../../components/States';
import { useToast } from '../../components/Toast';
import { apiPost, errorCode, errorMessage, probeEndpoint } from '../../lib/api';
import { DASH, fmtInt, fmtMoney, fmtSigned } from '../../lib/format';
import { useAsyncData } from '../../lib/hooks';
import type { Draft, Suggestion, SuggestionsKpi, SuggestionsResponse } from '../../app/types';
import { navigate } from '../../app/router';
import { ExplainDrawer } from './ExplainDrawer';

export interface SuggestionsPanelProps {
  data: SuggestionsResponse | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** 独立页：启用分页 */
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  onPage?: (page: number) => void;
  onPageSize?: (size: number) => void;
  /** 筛选工具条插槽 */
  toolbar?: ReactNode;
  /** 产物面板内嵌时去掉分页/外框，标题更紧凑 */
  embedded?: boolean;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** 生成草稿成功（会话内可据此提示/切换 artifact） */
  onDraftCreated?: (draft: Draft) => void;
  /** 是否允许写操作（建草稿 / 导出） */
  allowWrite?: boolean;
  /** 会话内生成草稿时带上 session_id（契约 §6 POST /api/drafts 可选字段） */
  sessionId?: string;
}

const FLAG_META: Record<string, { label: string; tone: string; tip: string }> = {
  stale_data: { label: '数据过期', tone: 'ra-tag-danger', tip: '库存快照陈旧（staleness_days > freshness_days），默认不进自动草稿' },
  negative_sellable: { label: '可售为负', tone: 'ra-tag-danger', tip: '可售库存为负，通常由超卖/占用导致' },
  override: { label: '人工改量', tone: 'ra-tag-warn', tip: '采购数量被人工修改，偏离系统建议' },
  slot_risk: { label: '库位风险', tone: 'ra-tag-warn', tip: '库位/容量风险提示（增强字段 slot_risk）' },
};

/** 服务端数值展示：整数不带小数，非整数最多 4 位且去掉尾随 0（纯格式化） */
function fmtQty(value: number | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return DASH;
  if (Number.isInteger(value)) return fmtInt(value);
  return value.toFixed(4).replace(/\.?0+$/, '');
}

/** 从服务端 kpi 中读取第一个存在的数值字段（不聚合、不推算） */
function readNum(kpi: SuggestionsKpi | undefined, keys: string[]): number | null {
  if (!kpi) return null;
  for (const key of keys) {
    const value = kpi[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function SuggestionsPanel({
  data,
  loading = false,
  error = null,
  onRetry,
  page = 1,
  pageSize = 20,
  total,
  totalPages,
  onPage,
  onPageSize,
  toolbar,
  embedded = false,
  title,
  subtitle,
  onDraftCreated,
  allowWrite = true,
  sessionId,
}: SuggestionsPanelProps) {
  const toast = useToast();
  const rows = data?.rows ?? [];
  const kpi = data?.kpi;
  const plan = data?.plan ?? null;

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState | null>(null);
  const [explainTarget, setExplainTarget] = useState<Suggestion | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const csvProbe = useAsyncData<boolean>(() => probeEndpoint('/export/csv'), []);
  const csvAvailable = csvProbe.data === true;

  // 采购数量：未编辑时回落到服务端 apply_num / suggest_num
  const applyOf = (row: Suggestion): number => {
    const raw = qtyDraft[row.sku_code];
    if (raw !== undefined) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    return row.apply_num ?? row.suggest_num ?? 0;
  };

  const setQty = (skuCode: string, raw: string) => {
    const cleaned = raw.replace(/[^\d-]/g, '');
    setQtyDraft((prev) => ({ ...prev, [skuCode]: cleaned }));
  };

  const revertQty = (skuCode: string) => {
    setQtyDraft((prev) => {
      if (!(skuCode in prev)) return prev;
      const next = { ...prev };
      delete next[skuCode];
      return next;
    });
  };

  const selectedRows = useMemo(() => rows.filter((row) => selected.has(row.sku_code)), [rows, selected]);

  const selectedQty = useMemo(
    () => selectedRows.reduce((sum, row) => sum + applyOf(row), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedRows, qtyDraft],
  );

  const selectedAmount = useMemo(() => {
    const withAmount = selectedRows.filter((row) => typeof row.amount === 'number');
    if (withAmount.length === 0) return null;
    return withAmount.reduce((sum, row) => sum + (row.amount ?? 0), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRows, qtyDraft]);

  const dirtySelected = useMemo(
    () =>
      selectedRows.filter((row) => {
        const raw = qtyDraft[row.sku_code];
        if (raw === undefined) return false;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed !== (row.apply_num ?? row.suggest_num ?? 0);
      }).length,
    [selectedRows, qtyDraft],
  );

  const createDraft = async () => {
    if (selectedRows.length === 0) {
      toast('请先勾选需要补货的商品', 'info');
      return;
    }
    setCreating(true);
    setDraftError(null);
    try {
      // 契约 §6：POST /api/drafts → 201 { draft }（只产草稿，不提交）
      const payload = {
        kind: 'purchase' as const,
        items: selectedRows.map((row) => ({ sku_code: row.sku_code, apply_num: applyOf(row) })),
        expected_arrival: data?.expected_arrival,
        remark: `来自补货建议（${plan?.plan_name ?? '当前方案'}）`,
        session_id: sessionId,
      };
      const response = await apiPost<Draft | { draft?: Draft }>('/drafts', payload);
      const draft =
        response && typeof response === 'object' && 'draft' in response
          ? (response as { draft?: Draft }).draft
          : (response as Draft);
      const draftId = draft?.draft_id ?? draft?.id ?? '（服务端未返回 id）';
      toast(`草稿已生成：${draftId}`, 'ok');
      setSelected(new Set());
      setQtyDraft({});
      if (draft) onDraftCreated?.(draft);
    } catch (e: unknown) {
      const code = errorCode(e);
      const message =
        code === 'NOT_FOUND'
          ? '草稿接口未就绪（POST /api/drafts 返回 404）。请稍后重试；如持续失败请联系管理员。'
          : `生成草稿失败：${errorMessage(e)}`;
      setDraftError(message);
      toast(message, 'err');
    } finally {
      setCreating(false);
    }
  };

  const exportCsv = async () => {
    const params = new URLSearchParams();
    if (plan?.plan_id) params.set('plan_id', plan.plan_id);
    if (data?.as_of) params.set('as_of', data.as_of);
    if (data?.expected_arrival) params.set('expected_arrival', data.expected_arrival);
    try {
      const res = await fetch(`/api/export/csv?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `补货建议_${data?.as_of ?? 'export'}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast('CSV 已开始下载', 'ok');
    } catch (e: unknown) {
      toast(`导出失败：${errorMessage(e)}`, 'err');
    }
  };

  const columns: Column<Suggestion>[] = [
    {
      key: 'product_name',
      header: '商品名称',
      sortable: true,
      sortValue: (row) => row.product_name ?? row.sku_code,
      render: (row) => (
        <div className="ra-prod-cell">
          <span className="ra-prod-name">
            <button
              type="button"
              className="ra-link"
              style={{ textAlign: 'left' }}
              onClick={() => setExplainTarget(row)}
              data-tip="点击查看该行的计算解释（terms / 逐日系数 / 闸门）"
            >
              {row.product_name ?? row.sku_code}
            </button>
          </span>
          <span className="ra-prod-meta">
            {row.sku_code}
            {row.spec ? ` · ${row.spec}` : ''}
          </span>
          {row.flags && row.flags.length > 0 ? (
            <span className="ra-flag-row">
              {row.flags.map((flag) => (
                <span
                  key={flag}
                  className={`ra-tag ${FLAG_META[flag]?.tone ?? 'ra-tag-gray'}`}
                  data-tip={FLAG_META[flag]?.tip ?? flag}
                >
                  {FLAG_META[flag]?.label ?? flag}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'unit',
      header: '单位',
      align: 'center',
      render: (row) => <span className="ra-muted">{row.unit ?? DASH}</span>,
    },
    {
      key: 'stock_upper',
      header: '库存上限',
      subHeader: '上限 / 下限',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.stock_upper ?? 0,
      render: (row) => (
        <div>
          <div className="ra-num">{fmtInt(row.stock_upper)}</div>
          <div className="ra-subline">下限 {fmtInt(row.stock_lower)}</div>
        </div>
      ),
    },
    {
      key: 'avg_daily_sales',
      header: '日均销量',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.avg_daily_sales ?? 0,
      render: (row) => (
        <span
          className="ra-num"
          data-tip={`近 15 个自然日窗口（含零销量日）；展示值 ${fmtQty(row.avg_daily_sales)} 不参与运算，运算用 avg_daily_sales_exact（H2/H7）`}
          tabIndex={0}
        >
          {fmtQty(row.avg_daily_sales)}
        </span>
      ),
    },
    {
      key: 'sellable_stock',
      header: '可售库存',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.sellable_stock ?? 0,
      render: (row) => (
        <span className={`ra-num${(row.sellable_stock ?? 0) < 0 ? ' ra-danger-text' : ''}`}>
          {fmtInt(row.sellable_stock)}
        </span>
      ),
    },
    {
      key: 'in_transit_stock',
      header: '在途库存',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.in_transit_stock ?? 0,
      render: (row) => <span className="ra-num">{fmtInt(row.in_transit_stock)}</span>,
    },
    {
      key: 'suggest_num',
      header: '建议数量',
      subHeader: '系统只读',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.suggest_num ?? 0,
      render: (row) => (
        <span className="ra-row ra-gap-1" style={{ justifyContent: 'flex-end' }}>
          <span className="ra-readonly-num" aria-label={`系统建议数量 ${fmtInt(row.suggest_num)}，只读`}>
            {fmtInt(row.suggest_num)}
          </span>
          <span
            className={`ra-prov ra-prov-${row.provenance === 'documented' ? 'documented' : row.provenance === 'enhancement' ? 'enhancement' : 'assumption'}`}
            data-tip={`${row.provenance === 'documented' ? '官方口径' : row.provenance === 'enhancement' ? '本实现增强' : '依赖未证实假设'}${
              row.assumptions && row.assumptions.length > 0 ? `（${row.assumptions.join('/')}）` : ''
            }\n建议数量 = ceil(suggest_raw_exact = ${fmtQty(row.suggest_raw_exact)})（H1）\n公式：${row.formula_text ?? '见方案'}`}
            tabIndex={0}
            aria-label="查看建议数量依据"
          >
            ⓘ
          </span>
        </span>
      ),
    },
    {
      key: 'apply_num',
      header: '采购数量',
      subHeader: '人工可改',
      align: 'right',
      sortable: true,
      sortValue: (row) => applyOf(row),
      render: (row) => {
        const suggested = row.suggest_num ?? 0;
        const applied = applyOf(row);
        const delta = applied - suggested;
        const dirty = delta !== 0;
        const inputId = `ra-qty-${row.sku_code.replace(/[^\w-]/g, '_')}`;
        return (
          <span className="ra-row ra-gap-1" style={{ justifyContent: 'flex-end' }}>
            <label htmlFor={inputId} className="ra-sr-only">
              {`${row.product_name ?? row.sku_code} 的采购数量`}
            </label>
            <input
              id={inputId}
              className={`ra-input ra-qty-input${dirty ? ' ra-qty-dirty' : ''}`}
              value={qtyDraft[row.sku_code] ?? String(row.apply_num ?? row.suggest_num ?? '')}
              inputMode="numeric"
              onChange={(event) => setQty(row.sku_code, event.target.value)}
              onBlur={() => {
                const raw = qtyDraft[row.sku_code];
                if (raw === undefined) return;
                if (raw === '' || Number.isNaN(Number.parseInt(raw, 10))) revertQty(row.sku_code);
              }}
              aria-label={`${row.product_name ?? row.sku_code} 采购数量`}
            />
            {dirty ? (
              <span
                className={`ra-delta ${delta > 0 ? 'ra-delta-up' : 'ra-delta-down'}`}
                data-tip={`人工采购数量 ${applied} 相对系统建议 ${suggested} 偏离 ${fmtSigned(delta)}`}
              >
                {fmtSigned(delta)}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '操作',
      align: 'center',
      width: 92,
      render: (row) => (
        <div className="ra-row-actions">
          <button
            type="button"
            className="ra-btn ra-btn-sm"
            onClick={() => navigate(`/sku/${encodeURIComponent(row.sku_code)}`)}
            title="打开 SKU 详情：库存四层 / 90 天曲线 / 各方案对照 / 参数来源"
          >
            详情
          </button>
          <button type="button" className="ra-btn ra-btn-sm ra-btn-ghost" onClick={() => setExplainTarget(row)}>
            解释
          </button>
        </div>
      ),
    },
  ];

  const kpiSkuCount = readNum(kpi, ['sku_count', 'suggest_sku_count']);
  const kpiLowStock = readNum(kpi, ['low_stock_count']);
  const kpiStale = readNum(kpi, ['stale_sku_count']);
  const kpiQty = readNum(kpi, ['total_suggest_num', 'total_qty']);
  const kpiAmount = readNum(kpi, ['total_amount', 'suggest_amount']);
  const hasAnyKpi =
    kpiSkuCount !== null || kpiLowStock !== null || kpiQty !== null || kpiAmount !== null || kpiStale !== null;

  const header = title ? (
    <div className="ra-card-head">
      <div className="ra-card-title">
        {title}
        {subtitle ? <span className="ra-card-sub">{subtitle}</span> : null}
      </div>
      <div className="ra-card-actions">
        {data?.as_of ? <span className="ra-faint ra-xs">as_of {data.as_of}</span> : null}
        {allowWrite && csvAvailable ? (
          <button type="button" className="ra-btn ra-btn-sm" onClick={exportCsv}>
            导出 CSV
          </button>
        ) : null}
      </div>
    </div>
  ) : null;

  const body = (
    <>
      {error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock text="正在加载补货建议…" />
      ) : (
        <>
          <CitationStrip
            provenance={data?.provenance ?? plan?.provenance}
            formulaText={data?.formula_text ?? plan?.formula_text}
            planName={plan?.plan_name}
            planType={plan?.plan_type}
            assumptions={data?.assumptions ?? []}
            guardNote={data?.guard_note}
            asOf={data?.as_of}
            expectedArrival={data?.expected_arrival}
          />

          {hasAnyKpi ? (
            <KpiRow>
              <Kpi
                label="建议 SKU 数"
                value={fmtInt(kpiSkuCount)}
                unit="个"
                foot="来源：服务端 KPI"
                hint="KPI 全部来自服务端返回值，前端不做聚合"
              />
              <Kpi
                label="低库存预警"
                value={fmtInt(kpiLowStock)}
                unit="个"
                tone={kpiLowStock !== null && kpiLowStock > 0 ? 'danger' : undefined}
                foot="来源：服务端 KPI"
              />
              <Kpi
                label="建议补货总量"
                value={fmtInt(kpiQty)}
                unit="件"
                foot="来源：服务端 KPI"
              />
              <Kpi
                label="预计采购金额"
                value={fmtMoney(kpiAmount)}
                foot="来源：服务端 KPI"
              />
              {kpiStale !== null ? (
                <Kpi
                  label="数据过期 SKU"
                  value={fmtInt(kpiStale)}
                  unit="个"
                  tone={kpiStale > 0 ? 'warn' : 'ok'}
                  foot="来源：服务端 KPI"
                />
              ) : null}
            </KpiRow>
          ) : (
            <InlineAlert tone="warn">
              服务端未返回 KPI 数据。为避免误导，前端不会用当前页数据自行聚合出数字。
            </InlineAlert>
          )}

          {toolbar}

          {sort && !embedded ? (
            <div className="ra-hint">排序仅作用于当前页（服务端分页接口不带排序参数）。</div>
          ) : null}

          {draftError ? (
            <InlineAlert
              tone="danger"
              actions={
                <button type="button" className="ra-btn ra-btn-sm" onClick={createDraft} disabled={creating}>
                  重试
                </button>
              }
            >
              {draftError}
            </InlineAlert>
          ) : null}

          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.sku_code}
            selectable
            selectedKeys={selected}
            onSelectionChange={setSelected}
            sort={sort}
            onSortChange={setSort}
            loading={loading}
            minWidth={1040}
            caption="补货建议表：建议数量只读，采购数量可编辑"
            emptyText="没有相关商品（当前筛选下所有 SKU 均不低于预警下限，或建议数量 ≤ 0）"
          />

          <div className="ra-sugg-foot">
            <span>
              已选 <b>{selectedRows.length}</b> / {rows.length} 行
            </span>
            <span className="ra-sugg-total">
              数量合计 <b>{fmtInt(selectedQty)}</b>
            </span>
            <span className="ra-sugg-total">
              金额小计 <b>{selectedAmount === null ? DASH : fmtMoney(selectedAmount)}</b>
            </span>
            {dirtySelected > 0 ? (
              <span className="ra-sugg-foot-note">
                （{dirtySelected} 行人工改量：数量合计按输入值汇总，金额以生成草稿后的服务端金额为准）
              </span>
            ) : (
              <span className="ra-sugg-foot-note">（合计仅汇总所选行的接口返回值，不做业务推算）</span>
            )}
            <span className="ra-right" />
            {allowWrite ? (
              <button
                type="button"
                className="ra-btn ra-btn-primary"
                onClick={createDraft}
                disabled={creating || selectedRows.length === 0}
                title={selectedRows.length === 0 ? '请先勾选商品' : '生成采购草稿（需人工审批后才能提交）'}
              >
                {creating ? <span className="ra-spinner" aria-hidden="true" /> : null}
                生成草稿{selectedRows.length > 0 ? `（${selectedRows.length}）` : ''}
              </button>
            ) : null}
          </div>

          {onPage ? (
            <Pager
              page={page}
              pageSize={pageSize}
              total={total ?? rows.length}
              totalPages={totalPages}
              onPage={onPage}
              onPageSize={onPageSize}
              disabled={loading}
            />
          ) : null}

          {plan?.formula_text && !data?.formula_text ? (
            <div className="ra-hint">注：公式文案来自方案 plan.formula_text。</div>
          ) : null}
        </>
      )}
    </>
  );

  return (
    <div className="ra-sugg">
      {embedded ? (
        <>
          {header}
          <div className="ra-card-body ra-col ra-gap-3">{body}</div>
        </>
      ) : (
        <div className="ra-card">
          {header}
          <div className="ra-card-body ra-col ra-gap-3">{body}</div>
        </div>
      )}

      <ExplainDrawer
        open={explainTarget !== null}
        suggestion={explainTarget}
        onClose={() => setExplainTarget(null)}
      />
    </div>
  );
}
