/**
 * DraftsPage.tsx — #/drafts 草稿单（列表 + 提交需审批 + 待审批清单）
 *
 * 任务流闭合：草稿（服务端资源）→ 选择/填写审批单号 → 提交正式单（幂等）。
 * 「待审批」清单单独展示，避免用户找不到 approval_id 而无路可走。
 */
import { useId, useState } from 'react';
import { apiGet } from '../../lib/api';
import { useAsyncData } from '../../lib/hooks';
import type { Approval, Draft, Order } from '../../app/types';
import { ErrorState, InlineAlert, LoadingBlock } from '../../components/States';
import { useToast } from '../../components/Toast';
import { fmtDateTime } from '../../lib/format';
import { DraftCard } from './DraftCard';

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部草稿' },
  { value: 'draft', label: '仅未提交' },
  { value: 'committed', label: '已提交' },
];

export function DraftsPage() {
  const toast = useToast();
  const statusId = useId();
  const [status, setStatus] = useState('');

  const draftsState = useAsyncData<Draft[]>(
    async (signal) => {
      const payload = await apiGet<{ drafts?: Draft[] } | Draft[]>(
        '/drafts',
        { status: status || undefined },
        signal,
      );
      if (Array.isArray(payload)) return payload;
      return payload?.drafts ?? [];
    },
    [status],
  );

  const approvalsState = useAsyncData<Approval[]>(
    async (signal) => {
      const payload = await apiGet<{ approvals?: Approval[] } | Approval[]>(
        '/approvals',
        { status: 'pending' },
        signal,
      );
      if (Array.isArray(payload)) return payload;
      return payload?.approvals ?? [];
    },
    [],
  );

  const drafts = draftsState.data ?? [];
  const approvals = approvalsState.data ?? [];

  const onCommitted = (_order: Order, draft: Draft) => {
    toast(`草稿 ${draft.draft_id ?? draft.id ?? ''} 已提交`, 'ok');
    draftsState.reload();
    approvalsState.reload();
  };

  return (
    <div className="ra-page">
      <div className="ra-page-head">
        <div>
          <div className="ra-page-title">草稿单</div>
          <div className="ra-page-sub">
            Agent 与定时任务只会产出草稿；提交正式单需要人工审批单号，服务端在缺少审批时直接拒绝。
          </div>
        </div>
        <div className="ra-page-actions">
          <label className="ra-field" htmlFor={statusId}>
            <span>状态</span>
            <select
              id={statusId}
              className="ra-select"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              style={{ width: 130 }}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ra-btn ra-btn-sm"
            onClick={() => {
              draftsState.reload();
              approvalsState.reload();
            }}
          >
            刷新
          </button>
        </div>
      </div>

      <div className="ra-card">
        <div className="ra-card-head">
          <div className="ra-card-title">
            待审批
            <span className="ra-badge-count">{approvals.length}</span>
            <span className="ra-card-sub">批准后即可在下方草稿上提交</span>
          </div>
        </div>
        <div className="ra-card-body">
          {approvalsState.error ? (
            <ErrorState compact message={approvalsState.error} onRetry={approvalsState.reload} />
          ) : approvalsState.loading && approvals.length === 0 ? (
            <LoadingBlock text="正在加载待审批…" />
          ) : approvals.length === 0 ? (
            <div className="ra-hint">
              当前没有待审批记录。审批单由 Agent 的写操作产生（例如生成草稿后请求提交审批）。
            </div>
          ) : (
            <div className="ra-approval-list">
              {approvals.map((approval) => (
                <div className="ra-pending-row" key={approval.id}>
                  <span className={`ra-tag ${approval.risk === 'high' ? 'ra-tag-danger' : 'ra-tag-warn'}`}>
                    风险 {approval.risk === 'high' ? '高' : approval.risk === 'medium' ? '中' : approval.risk ?? '—'}
                  </span>
                  <code className="ra-mono ra-sm">{approval.id}</code>
                  <span className="ra-grow ra-truncate" title={approval.summary}>
                    {approval.summary ?? '（无摘要）'}
                  </span>
                  {approval.draft_id ? <span className="ra-faint ra-xs">草稿 {approval.draft_id}</span> : null}
                  <span className="ra-faint ra-xs">{fmtDateTime(approval.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="ra-mt-4">
        {draftsState.error ? (
          <div className="ra-card">
            <ErrorState message={draftsState.error} onRetry={draftsState.reload} />
          </div>
        ) : draftsState.loading && drafts.length === 0 ? (
          <div className="ra-card">
            <LoadingBlock text="正在加载草稿…" />
          </div>
        ) : drafts.length === 0 ? (
          <div className="ra-card">
            <InlineAlert tone="info">
              没有草稿。可以在 <b>#/agent</b> 让助手生成建议并建草稿，或在 <b>#/suggestions</b>{' '}
              勾选商品后点「生成草稿」。
            </InlineAlert>
          </div>
        ) : (
          drafts.map((draft) => (
            <DraftCard
              key={draft.draft_id ?? draft.id ?? Math.random().toString(36)}
              draft={draft}
              pendingApprovals={approvals}
              onCommitted={onCommitted}
            />
          ))
        )}
      </div>
    </div>
  );
}
