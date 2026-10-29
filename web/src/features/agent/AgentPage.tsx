/**
 * AgentPage.tsx — `#/agent`：左会话 / 右产物（契约 §7 核心页）
 * ---------------------------------------------------------------------------
 * 结构对齐既有 CSS：`.ra-agent` 是两列网格，`ChatPanel` 自身渲染 `.ra-agent-left`
 * （含 `.ra-agent-head`），所以这里**不再包一层列容器**，只补一条状态条与右侧产物列。
 * 页面只做三件事：
 *  1) URL 的 `?s=<session_id>` 作为会话锚点（可分享/可刷新恢复）；
 *  2) 把 `useAgentSession` 的 state/actions 交给 ChatPanel；
 *  3) 把 artifacts/approvals 交给 ArtifactPanel（产物面板自行回查服务端，不自己算数）。
 */
import { useEffect, useMemo } from 'react';
import { ChatPanel } from './ChatPanel';
import { ArtifactPanel } from './ArtifactPanel';
import { useAgentSession } from './useAgentSession';
import { replaceQuery } from '../../app/router';
import { fmtInt } from '../../lib/format';
import type { HealthInfo } from '../../app/types';

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  connecting: '连接中',
  streaming: '流式生成',
  done: '完成',
  error: '出错',
  aborted: '已停止',
};

function statusTone(status: string): string {
  if (status === 'streaming' || status === 'connecting') return 'ra-status-live';
  if (status === 'error') return 'ra-status-err';
  if (status === 'done') return 'ra-status-ok';
  if (status === 'aborted') return 'ra-status-warn';
  return '';
}

export function AgentPage({ initialSessionId, health }: { initialSessionId: string | null; health: HealthInfo | null }) {
  const session = useAgentSession(initialSessionId);

  // URL 与会话同步（刷新/分享后可恢复）
  useEffect(() => {
    if (session.sessionId) replaceQuery({ s: session.sessionId });
  }, [session.sessionId]);

  const tokenText = useMemo(() => {
    const usage = session.usage;
    if (!usage) return '—';
    const total = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    const reasoning = usage.reasoning_tokens ? ` · 推理 ${fmtInt(usage.reasoning_tokens)}` : '';
    return `提示 ${fmtInt(usage.prompt_tokens ?? 0)} / 生成 ${fmtInt(usage.completion_tokens ?? 0)}${reasoning}（共 ${fmtInt(total)}）`;
  }, [session.usage]);

  return (
    <div className="ra-agent-wrap">
      <div className="ra-agent-bar">
        <div className="ra-agent-bar-left">
          <span className={`ra-status ${statusTone(session.status)}`} title="流式状态">
            <span className="ra-status-dot" aria-hidden="true" />
            {STATUS_LABEL[session.status] ?? session.status}
          </span>
          {session.step ? (
            <span className="ra-topbar-chip" title="Agent 多步循环进度">
              step {session.step.step}/{session.step.max_steps}
            </span>
          ) : null}
          <span className="ra-topbar-chip ra-pill-mono" title="会话 ID（可分享，刷新可恢复）">
            {session.sessionId ? session.sessionId.slice(0, 20) : '未创建会话'}
          </span>
        </div>
        <div className="ra-agent-bar-right">
          <span className="ra-topbar-chip" title="本轮 token 用量（来自 provider usage，非前端估算）">
            {tokenText}
          </span>
          <span className="ra-topbar-chip ra-pill-mono" title="模型">
            {health?.provider ?? '—'}/{health?.model ?? '—'}
          </span>
          <button
            type="button"
            className="ra-btn ra-btn-ghost ra-btn-sm"
            onClick={() => void session.reloadHistory()}
            disabled={!session.sessionId || session.loadingHistory}
          >
            {session.loadingHistory ? '载入中…' : '重新载入历史'}
          </button>
        </div>
      </div>

      <div className="ra-agent">
        <ChatPanel state={session} actions={session} />
        <section className="ra-agent-right" aria-label="产物">
          <ArtifactPanel
            artifacts={session.artifacts}
            approvals={session.approvals}
            onCommitted={() => void session.reloadHistory()}
          />
        </section>
      </div>
    </div>
  );
}

export default AgentPage;
