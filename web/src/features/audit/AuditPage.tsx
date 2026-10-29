/**
 * AuditPage.tsx — #/audit 审计日志（时间线 + 筛选）
 * 筛选：kind / session_id / limit（全部走服务端 GET /api/audit 的 query）。
 */
import { useId, useState } from 'react';
import { apiGet } from '../../lib/api';
import { useAsyncData } from '../../lib/hooks';
import type { AuditEvent } from '../../app/types';
import { ErrorState, LoadingBlock } from '../../components/States';
import { AuditTimeline } from './AuditTimeline';

const KIND_HINTS = [
  'tool_call',
  'tool_result',
  'approval',
  'session',
  'draft_create',
  'order_commit',
  'schedule_run',
];

export function AuditPage() {
  const kindId = useId();
  const sessionId = useId();
  const limitId = useId();

  const [kind, setKind] = useState('');
  const [session, setSession] = useState('');
  const [limit, setLimit] = useState(100);

  const state = useAsyncData<AuditEvent[]>(
    async (signal) => {
      const payload = await apiGet<{ events?: AuditEvent[] } | AuditEvent[]>(
        '/audit',
        {
          kind: kind || undefined,
          session_id: session || undefined,
          limit,
        },
        signal,
      );
      if (Array.isArray(payload)) return payload;
      return payload?.events ?? [];
    },
    [kind, session, limit],
  );

  const events = state.data ?? [];

  return (
    <div className="ra-page">
      <div className="ra-page-head">
        <div>
          <div className="ra-page-title">审计日志</div>
          <div className="ra-page-sub">
            每次工具调用（成功与失败）、审批决定、草稿提交都会留痕；这是「Agent 做了什么」的唯一事实源。
          </div>
        </div>
        <div className="ra-page-actions">
          <button type="button" className="ra-btn ra-btn-sm" onClick={state.reload} disabled={state.loading}>
            刷新
          </button>
        </div>
      </div>

      <div className="ra-card">
        <div className="ra-toolbar">
          <label className="ra-field" htmlFor={kindId}>
            <span>事件类型</span>
            <input
              id={kindId}
              className="ra-input"
              list="ra-audit-kinds"
              placeholder="全部"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              style={{ width: 150 }}
            />
            <datalist id="ra-audit-kinds">
              {KIND_HINTS.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>

          <label className="ra-field" htmlFor={sessionId}>
            <span>会话 ID</span>
            <input
              id={sessionId}
              className="ra-input"
              placeholder="按 session 过滤"
              value={session}
              onChange={(event) => setSession(event.target.value)}
              style={{ width: 220 }}
            />
          </label>

          <label className="ra-field" htmlFor={limitId}>
            <span>条数</span>
            <select
              id={limitId}
              className="ra-select"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              style={{ width: 92 }}
            >
              {[50, 100, 200, 500].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <button type="button" className="ra-btn ra-btn-link" onClick={() => { setKind(''); setSession(''); setLimit(100); }}>
            重置筛选条件
          </button>

          <span className="ra-right ra-faint ra-xs">共 {events.length} 条</span>
        </div>

        <div className="ra-card-body">
          {state.error ? (
            <ErrorState message={state.error} onRetry={state.reload} />
          ) : state.loading && events.length === 0 ? (
            <LoadingBlock text="正在加载审计事件…" />
          ) : (
            <AuditTimeline events={events} />
          )}
        </div>
      </div>
    </div>
  );
}
