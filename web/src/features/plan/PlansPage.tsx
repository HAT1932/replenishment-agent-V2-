/**
 * PlansPage.tsx — #/plans 补货方案列表
 *
 * 列（对齐官方方案列表 + 审计 §8 的增强项）：
 *   方案名称(+id 副行) | 类型 | 公式 | 溯源 | 制单人 | 创建时间 | 备注 | 操作
 * 系统默认方案禁删（服务端强制；UI 提前禁用并说明，避免用户点了才被拒）。
 */
import { useState } from 'react';
import { apiDelete, apiGet, errorCode, errorMessage } from '../../lib/api';
import { useAsyncData } from '../../lib/hooks';
import { navigate } from '../../app/router';
import type { Plan } from '../../app/types';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { ProvenanceTag } from '../../components/ProvenanceTag';
import { ErrorState } from '../../components/States';
import { useToast } from '../../components/Toast';
import { PLAN_TYPE_LABEL } from '../../components/Citation';
import { DASH, fmtDate } from '../../lib/format';

function configSummary(plan: Plan): string {
  const config = plan.config ?? {};
  const parts: string[] = [];
  if (config.purchase_cycle_days !== undefined) parts.push(`采购周期 ${config.purchase_cycle_days} 天`);
  if (config.coverage_days !== undefined) parts.push(`可售天数 ${config.coverage_days} 天`);
  if (config.weekend_coefficient_enabled) parts.push(`双休日系数 ${config.weekend_coefficient ?? '—'}`);
  if (config.holiday_coefficient_enabled) parts.push(`节假日系数 ${config.holiday_coefficient ?? '—'}`);
  return parts.join(' · ');
}

export function PlansPage() {
  const toast = useToast();
  const [pendingDelete, setPendingDelete] = useState<Plan | null>(null);
  const [deleting, setDeleting] = useState(false);

  const state = useAsyncData<Plan[]>(
    async (signal) => {
      const payload = await apiGet<{ plans?: Plan[] } | Plan[]>('/plans', undefined, signal);
      if (Array.isArray(payload)) return payload;
      return payload?.plans ?? [];
    },
    [],
  );

  const plans = state.data ?? [];

  const remove = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await apiDelete(`/plans/${encodeURIComponent(pendingDelete.plan_id)}`);
      toast(`已删除方案：${pendingDelete.plan_name}`, 'ok');
      setPendingDelete(null);
      state.reload();
    } catch (e: unknown) {
      const code = errorCode(e);
      toast(
        code === 'CONFLICT' || code === 'VALIDATION_ERROR'
          ? `无法删除：${errorMessage(e)}（系统默认方案禁删）`
          : `删除失败：${errorMessage(e)}`,
        'err',
      );
    } finally {
      setDeleting(false);
    }
  };

  const columns: Column<Plan>[] = [
    {
      key: 'plan_name',
      header: '方案名称',
      sortable: true,
      sortValue: (row) => row.plan_name,
      render: (row) => (
        <div className="ra-prod-cell">
          <span className="ra-prod-name">
            {row.plan_name}
            {row.is_default || row.deletable === false ? (
              <span className="ra-tag ra-tag-info">系统默认</span>
            ) : null}
          </span>
          <span className="ra-prod-meta">{row.plan_id}</span>
        </div>
      ),
    },
    {
      key: 'plan_type',
      header: '方案类型',
      render: (row) => (
        <span className="ra-chip">{PLAN_TYPE_LABEL[row.plan_type] ?? row.plan_type}</span>
      ),
    },
    {
      key: 'formula_text',
      header: '计算公式',
      render: (row) => (
        <span className="ra-mono ra-xs ra-muted ra-truncate" style={{ display: 'inline-block', maxWidth: 380 }} title={row.formula_text}>
          {row.formula_text ?? DASH}
        </span>
      ),
    },
    {
      key: 'provenance',
      header: '溯源',
      render: (row) => <ProvenanceTag provenance={row.provenance} assumptions={[]} showAssumptions={false} />,
    },
    {
      key: 'config',
      header: '关键参数',
      render: (row) => <span className="ra-hint">{configSummary(row) || DASH}</span>,
    },
    {
      key: 'created_by',
      header: '制单人',
      render: (row) => <span className="ra-muted">{row.created_by ?? DASH}</span>,
    },
    {
      key: 'created_at',
      header: '创建时间',
      sortable: true,
      sortValue: (row) => row.created_at ?? '',
      render: (row) => <span className="ra-muted">{fmtDate(row.created_at)}</span>,
    },
    {
      key: 'remark',
      header: '备注',
      render: (row) => (
        <span className="ra-muted ra-truncate" style={{ display: 'inline-block', maxWidth: 200 }} title={row.remark}>
          {row.remark ?? DASH}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'center',
      render: (row) => (
        <span className="ra-row ra-gap-2" style={{ justifyContent: 'center' }}>
          <button
            type="button"
            className="ra-btn ra-btn-sm"
            onClick={() => navigate(`/plans/${encodeURIComponent(row.plan_id)}`)}
          >
            编辑
          </button>
          <button
            type="button"
            className="ra-btn ra-btn-sm"
            disabled={row.is_default === true || row.deletable === false}
            title={
              row.is_default || row.deletable === false
                ? '系统默认方案不可删除（服务端强制）'
                : '删除方案（需二次确认）'
            }
            onClick={() => setPendingDelete(row)}
          >
            删除
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="ra-page">
      <div className="ra-page-head">
        <div>
          <div className="ra-page-title">补货方案</div>
          <div className="ra-page-sub">
            三个官方方案（按日均销量 / 按库存上限 / 自定义）的公式逐字来自官方文档；综合系数按到货窗口逐日加权（H3）。
          </div>
        </div>
        <div className="ra-page-actions">
          <button type="button" className="ra-btn ra-btn-primary" onClick={() => navigate('/plans/new')}>
            新建方案
          </button>
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
            rows={plans}
            rowKey={(row) => row.plan_id}
            loading={state.loading}
            emptyText="还没有补货方案。系统默认方案应由后端 seed 提供；可点「新建方案」自建。"
            caption="补货方案列表"
          />
        )}
      </div>

      <Modal
        open={pendingDelete !== null}
        title="删除方案"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <button type="button" className="ra-btn" onClick={() => setPendingDelete(null)} disabled={deleting}>
              取消
            </button>
            <button type="button" className="ra-btn ra-btn-danger" onClick={() => void remove()} disabled={deleting}>
              {deleting ? <span className="ra-spinner" aria-hidden="true" /> : null}
              确认删除
            </button>
          </>
        }
      >
        <div className="ra-col ra-gap-3">
          <div className="ra-alert ra-alert-warn">
            删除后，使用该方案生成的历史建议不会被删除（审计留痕），但该方案不再可用。
          </div>
          <div>
            即将删除：<b>{pendingDelete?.plan_name}</b>
            <span className="ra-faint ra-mono ra-xs">（{pendingDelete?.plan_id}）</span>
          </div>
        </div>
      </Modal>
    </div>
  );
}
