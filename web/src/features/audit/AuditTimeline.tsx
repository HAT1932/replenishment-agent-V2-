/**
 * AuditTimeline.tsx — 审计事件时间线（#/audit 与会话产物共用）
 * 每条：时间 / actor / kind / 工具 / 成败 / 耗时 / 可展开 payload。
 */
import type { AuditEvent } from '../../app/types';
import { fmtDateTime, fmtDuration, fmtTime, prettyJson } from '../../lib/format';

const ACTOR_TAG: Record<string, string> = {
  agent: 'ra-tag-info',
  human: 'ra-tag-purple',
  scheduler: 'ra-tag-warn',
};

const ACTOR_LABEL: Record<string, string> = {
  agent: '模型',
  human: '人工',
  scheduler: '定时',
};

export function AuditTimeline({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="ra-empty" style={{ padding: '28px 16px' }}>
        <div className="ra-empty-icon" aria-hidden="true">
          🗂️
        </div>
        <div className="ra-empty-title">没有审计事件</div>
        <div>当前筛选条件下没有留痕记录。Agent 每次工具调用（成功与失败）都会写审计。</div>
      </div>
    );
  }

  return (
    <div className="ra-audit-list">
      {events.map((event, index) => {
        const key = event.id ?? `${event.ts}-${index}`;
        const actor = event.actor ?? 'agent';
        return (
          <div className="ra-audit-item" key={key} data-ok={event.ok === undefined ? undefined : String(event.ok)}>
            <div className="ra-audit-head">
              <span className="ra-audit-ts" title={event.ts}>
                {fmtDateTime(event.ts)}
              </span>
              <span className={`ra-tag ${ACTOR_TAG[actor] ?? 'ra-tag-gray'}`}>
                {ACTOR_LABEL[actor] ?? actor}
              </span>
              <span className="ra-audit-kind">{event.kind ?? '事件'}</span>
              {event.tool ? <code className="ra-audit-tool">{event.tool}</code> : null}
              {event.ok === false ? <span className="ra-tag ra-tag-danger">失败</span> : null}
              {event.ok === true ? <span className="ra-tag ra-tag-ok">成功</span> : null}
            </div>

            <div className="ra-audit-meta">
              <span>时间 {fmtTime(event.ts)}</span>
              {event.duration_ms !== undefined ? <span>耗时 {fmtDuration(event.duration_ms)}</span> : null}
              {event.session_id ? <span className="ra-mono">session {event.session_id}</span> : null}
              {event.provenance ? <span>provenance {event.provenance}</span> : null}
            </div>

            {event.payload !== undefined && event.payload !== null ? (
              <details className="ra-audit-payload">
                <summary>查看 payload</summary>
                <pre className="ra-pre">{prettyJson(event.payload)}</pre>
              </details>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
