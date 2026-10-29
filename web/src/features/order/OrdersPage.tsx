/**
 * OrdersPage.tsx — #/orders 正式单（采购 / 要货 两类切换）
 * 明细用抽屉展示，避免长表格挤压主列表。
 */
import { useState } from 'react';
import { apiGet } from '../../lib/api';
import { useAsyncData } from '../../lib/hooks';
import type { DraftItem, Order } from '../../app/types';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { Drawer } from '../../components/Drawer';
import { ErrorState, LoadingBlock } from '../../components/States';
import { DASH, fmtDateTime, fmtInt, fmtMoney } from '../../lib/format';

type Kind = 'purchase' | 'apply';

const KIND_LABEL: Record<Kind, string> = { purchase: '采购单', apply: '要货申请单' };

export function OrdersPage() {
  const [kind, setKind] = useState<Kind>('purchase');
  const [detail, setDetail] = useState<Order | null>(null);

  const state = useAsyncData<Order[]>(
    async (signal) => {
      const payload = await apiGet<{ orders?: Order[] } | Order[]>('/orders', { kind }, signal);
      if (Array.isArray(payload)) return payload;
      return payload?.orders ?? [];
    },
    [kind],
  );

  const orders = state.data ?? [];

  const columns: Column<Order>[] = [
    {
      key: 'biz_no',
      header: '单号',
      render: (row) => (
        <span className="ra-mono">{row.biz_no ?? row.order_id ?? row.id ?? DASH}</span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: (row) => {
        const status = row.status ?? '—';
        const tone = /完成|已入|已出/.test(status)
          ? 'ra-tag-ok'
          : /取消|驳回/.test(status)
            ? 'ra-tag-danger'
            : 'ra-tag-warn';
        return <span className={`ra-tag ${tone}`}>{status}</span>;
      },
    },
    {
      key: 'kind',
      header: '类型',
      render: (row) => <span className="ra-muted">{KIND_LABEL[(row.kind as Kind) ?? 'purchase'] ?? row.kind ?? DASH}</span>,
    },
    {
      key: 'total_qty',
      header: '总数量',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.total_qty ?? 0,
      render: (row) => <span className="ra-num">{fmtInt(row.total_qty)}</span>,
    },
    {
      key: 'total_amount',
      header: '总金额',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.total_amount ?? 0,
      render: (row) => <span className="ra-num">{fmtMoney(row.total_amount)}</span>,
    },
    {
      key: 'draft_id',
      header: '来源草稿',
      render: (row) => <span className="ra-faint ra-mono ra-xs">{row.draft_id ?? DASH}</span>,
    },
    {
      key: 'created_at',
      header: '创建时间',
      sortable: true,
      sortValue: (row) => row.created_at ?? '',
      render: (row) => <span className="ra-muted">{fmtDateTime(row.created_at)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      align: 'center',
      render: (row) => (
        <button type="button" className="ra-btn ra-btn-sm" onClick={() => setDetail(row)}>
          明细
        </button>
      ),
    },
  ];

  const detailItems: DraftItem[] = detail?.items ?? [];

  return (
    <div className="ra-page">
      <div className="ra-page-head">
        <div>
          <div className="ra-page-title">正式单</div>
          <div className="ra-page-sub">由草稿经人工审批后提交生成（幂等：同一草稿只生成一张正式单）。</div>
        </div>
        <div className="ra-page-actions">
          <div className="ra-seg" role="group" aria-label="单据类型">
            {(['purchase', 'apply'] as Kind[]).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={kind === item}
                onClick={() => setKind(item)}
              >
                {KIND_LABEL[item]}
              </button>
            ))}
          </div>
          <button type="button" className="ra-btn ra-btn-sm" onClick={state.reload} disabled={state.loading}>
            刷新
          </button>
        </div>
      </div>

      <div className="ra-card">
        {state.error ? (
          <ErrorState message={state.error} onRetry={state.reload} />
        ) : (
          <DataTable
            columns={columns}
            rows={orders}
            rowKey={(row) => row.order_id ?? row.id ?? row.biz_no ?? JSON.stringify(row).slice(0, 40)}
            loading={state.loading}
            emptyText={`还没有${KIND_LABEL[kind]}。需先在 #/drafts 提交草稿（带审批单号）。`}
            caption={`${KIND_LABEL[kind]}列表`}
          />
        )}
      </div>

      {state.loading && orders.length === 0 && !state.error ? <LoadingBlock text="正在加载正式单…" /> : null}

      <Drawer
        open={detail !== null}
        title={`单据明细 ${detail?.biz_no ?? detail?.order_id ?? ''}`}
        subtitle={`${detail?.status ?? ''} · ${fmtDateTime(detail?.created_at)}`}
        onClose={() => setDetail(null)}
      >
        {detailItems.length === 0 ? (
          <div className="ra-hint">服务端未返回明细行（items）。</div>
        ) : (
          <div className="ra-col ra-gap-3">
            <div className="ra-items">
              <div className="ra-item-row ra-item-row-head">
                <span>商品</span>
                <span>单位</span>
                <span className="ra-num">数量</span>
                <span className="ra-num">单价</span>
                <span className="ra-num">小计</span>
              </div>
              {detailItems.map((item, index) => (
                <div className="ra-item-row" key={`${item.sku_code ?? 'row'}-${index}`}>
                  <span className="ra-truncate">{item.product_name ?? item.sku_code ?? DASH}</span>
                  <span className="ra-muted">{item.unit ?? DASH}</span>
                  <span className="ra-num">{fmtInt(item.apply_num)}</span>
                  <span className="ra-num">{fmtMoney(item.unit_cost)}</span>
                  <span className="ra-num">{fmtMoney(item.amount)}</span>
                </div>
              ))}
            </div>
            <div className="ra-hint">
              合计数量 {fmtInt(detail?.total_qty)} · 合计金额 {fmtMoney(detail?.total_amount)}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
