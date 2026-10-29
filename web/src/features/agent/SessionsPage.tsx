/**
 * SessionsPage.tsx — #/sessions 历史会话（可进 #/agent?s=<id>）
 * 新建 / 打开 / 删除（删除需二次确认：破坏性操作必须有确认，审计保留）。
 */
import { useState } from 'react';
import { apiDelete, apiGet, apiPost, errorMessage } from '../../lib/api';
import { useAsyncData } from '../../lib/hooks';
import { navigate } from '../../app/router';
import type { SessionSummary } from '../../app/types';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { ErrorState } from '../../components/States';
import { useToast } from '../../components/Toast';
import { DASH, fmtDateTime, fmtInt } from '../../lib/format';

function sessionKey(session: SessionSummary): string {
  return session.session_id ?? session.id ?? '';
}

export function SessionsPage() {
  const toast = useToast();
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);

  const state = useAsyncData<SessionSummary[]>(
    async (signal) => {
      const payload = await apiGet<{ sessions?: SessionSummary[] } | SessionSummary[]>(
        '/sessions',
        undefined,
        signal,
      );
      if (Array.isArray(payload)) return payload;
      return payload?.sessions ?? [];
    },
    [],
  );

  const sessions = state.data ?? [];

  const createSession = async () => {
    setCreating(true);
    try {
      const created = await apiPost<{ session_id?: string; session?: SessionSummary }>('/sessions', {});
      const id = created?.session_id ?? created?.session?.session_id ?? null;
      if (!id) throw new Error('后端未返回 session_id');
      toast('已创建新会话', 'ok');
      navigate(`/agent?s=${encodeURIComponent(id)}`);
    } catch (e: unknown) {
      toast(`创建会话失败：${errorMessage(e)}`, 'err');
    } finally {
      setCreating(false);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    const id = sessionKey(pendingDelete);
    setDeleting(true);
    try {
      await apiDelete(`/sessions/${encodeURIComponent(id)}`);
      toast('会话已删除（审计保留）', 'ok');
      setPendingDelete(null);
      state.reload();
    } catch (e: unknown) {
      toast(`删除失败：${errorMessage(e)}`, 'err');
    } finally {
      setDeleting(false);
    }
  };

  const columns: Column<SessionSummary>[] = [
    {
      key: 'title',
      header: '会话标题',
      sortable: true,
      sortValue: (row) => row.title ?? '',
      render: (row) => (
        <div className="ra-col ra-gap-1">
          <span className="ra-session-row-title">{row.title ?? '（无标题会话）'}</span>
          <span className="ra-session-row-sub">{sessionKey(row)}</span>
        </div>
      ),
    },
    {
      key: 'message_count',
      header: '消息数',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.message_count ?? 0,
      render: (row) => <span className="ra-num">{fmtInt(row.message_count)}</span>,
    },
    {
      key: 'created_at',
      header: '创建时间',
      sortable: true,
      sortValue: (row) => row.created_at ?? '',
      render: (row) => <span className="ra-muted">{fmtDateTime(row.created_at)}</span>,
    },
    {
      key: 'last_message_at',
      header: '最后消息',
      sortable: true,
      sortValue: (row) => row.last_message_at ?? '',
      render: (row) => <span className="ra-muted">{fmtDateTime(row.last_message_at)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      align: 'center',
      render: (row) => {
        const id = sessionKey(row);
        return (
          <span className="ra-row ra-gap-2" style={{ justifyContent: 'center' }}>
            <button
              type="button"
              className="ra-btn ra-btn-sm"
              onClick={() => navigate(`/agent?s=${encodeURIComponent(id)}`)}
              disabled={id === ''}
            >
              打开
            </button>
            <button
              type="button"
              className="ra-btn ra-btn-sm"
              onClick={() => setPendingDelete(row)}
              disabled={id === ''}
            >
              删除
            </button>
          </span>
        );
      },
    },
  ];

  return (
    <div className="ra-page">
      <div className="ra-page-head">
        <div>
          <div className="ra-page-title">历史会话</div>
          <div className="ra-page-sub">
            每次 Copilot 对话都留档：消息流、工具调用与产物都可回看；删除会话不会删审计。
          </div>
        </div>
        <div className="ra-page-actions">
          <button
            type="button"
            className="ra-btn ra-btn-primary"
            onClick={() => void createSession()}
            disabled={creating}
          >
            {creating ? <span className="ra-spinner" aria-hidden="true" /> : null}
            新建会话
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
            rows={sessions}
            rowKey={(row) => sessionKey(row) || JSON.stringify(row).slice(0, 32)}
            loading={state.loading}
            emptyText="还没有会话。点「新建会话」或在 #/agent 直接提问即可创建。"
            caption="历史会话列表"
            onRowClick={(row) => {
              const id = sessionKey(row);
              if (id) navigate(`/agent?s=${encodeURIComponent(id)}`);
            }}
          />
        )}
      </div>

      <Modal
        open={pendingDelete !== null}
        title="删除会话"
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
            会话与其消息、产物会被删除；<b>审计事件保留</b>（治理要求）。此操作不可撤销。
          </div>
          <div>
            即将删除：<b>{pendingDelete?.title ?? '（无标题会话）'}</b>
            <div className="ra-faint ra-mono ra-xs">{pendingDelete ? sessionKey(pendingDelete) : DASH}</div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
