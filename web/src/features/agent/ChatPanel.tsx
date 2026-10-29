/**
 * ChatPanel.tsx — 左栏会话面（契约 §5 / §7）
 *
 * 事件可视化：
 *  - reasoning_delta → 可折叠「思考过程」块（默认收起，展开看原文）
 *  - tool_call / tool_result → 时间线卡片（工具名 / 参数 JSON / 耗时 / ok 徽标 / 可展开原始结果）
 *  - approval_required → 审批卡（摘要 + 风险级别 + 批准/驳回 + 备注）
 *  - error → 红色提示，并给「重发 / 重连」出口（SSE 断流不留死局）
 * 输入：Enter 发送、Shift+Enter 换行、发送中禁用并可「停止」（abort）。
 */
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useToast } from '../../components/Toast';
import { DASH, fmtDuration, prettyJson, truncate } from '../../lib/format';
import type { AgentSessionActions, AgentSessionState } from './useAgentSession';
import type { ApprovalDecision, ChatBlock, StreamStatus, ToolResultState } from '../../app/types';
import type { SseEvent } from '../../app/types';

const STATUS_TEXT: Record<StreamStatus, string> = {
  idle: '空闲',
  connecting: '连接中',
  streaming: '流式生成',
  done: '完成',
  error: '出错',
  aborted: '已停止',
};

const STATUS_TONE: Record<StreamStatus, string> = {
  idle: 'ra-status-idle',
  connecting: 'ra-status-live',
  streaming: 'ra-status-live',
  done: 'ra-status-ok',
  error: 'ra-status-err',
  aborted: 'ra-status-warn',
};

const SAMPLE_PROMPTS = [
  '帮我看看今天哪些商品需要补货，按默认方案算，只列低库存的。',
  '用自定义方案算近 7 天的补货建议，预计到货日设为三天后，并生成一张采购草稿。',
  '解释一下某个 SKU 的建议数量是怎么算出来的，把逐日系数也讲清楚。',
];

/** 工具结果摘要行 */
function toolSummary(result: ToolResultState | undefined): string {
  if (!result) return '执行中…';
  if (result.summary && result.summary.trim() !== '') return result.summary;
  if (result.errorMessage) return result.errorMessage;
  if (result.data !== undefined) return truncate(prettyJson(result.data, 0), 180);
  return result.ok ? '执行完成' : '执行失败';
}

function ToolCard({ block }: { block: Extract<ChatBlock, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const result = block.result;
  const ok = block.status === 'done' ? true : block.status === 'error' ? false : undefined;

  return (
    <div className="ra-tool" data-ok={ok === undefined ? undefined : String(ok)} data-running={block.status === 'running' ? 'true' : undefined}>
      <div className="ra-tool-head">
        <span className="ra-tool-name">{block.name}</span>
        {block.step !== undefined ? <span className="ra-tool-step">step {block.step}</span> : null}
        <span className="ra-tool-meta">
          {block.status === 'running' ? (
            <>
              <span className="ra-spinner" aria-hidden="true" /> 执行中
            </>
          ) : (
            <>
              {result?.duration_ms !== undefined ? <span>{fmtDuration(result.duration_ms)}</span> : null}
              <span className={`ra-tag ${block.status === 'error' ? 'ra-tag-danger' : 'ra-tag-ok'}`}>
                {block.status === 'error' ? '失败' : 'ok'}
              </span>
            </>
          )}
        </span>
      </div>

      <div className="ra-tool-body">
        <div className="ra-tool-summary">{toolSummary(result)}</div>

        {result?.errorCode || result?.errorMessage ? (
          <div className="ra-error-text" role="alert">
            {result.errorCode ? `[${result.errorCode}] ` : ''}
            {result.errorMessage ?? ''}
          </div>
        ) : null}

        <details className="ra-tool-details" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>参数与原始结果</summary>
          <div className="ra-col ra-gap-2">
            <div>
              <div className="ra-hint">参数 args</div>
              <pre className="ra-pre">{prettyJson(block.args)}</pre>
            </div>
            {result ? (
              <div>
                <div className="ra-hint">原始结果 data</div>
                <pre className="ra-pre">
                  {result.data !== undefined
                    ? prettyJson(result.data)
                    : result.summary ?? result.errorMessage ?? '（无 data）'}
                </pre>
              </div>
            ) : null}
          </div>
        </details>
      </div>
    </div>
  );
}

function ApprovalCard({
  block,
  onResolve,
  disabled,
}: {
  block: Extract<ChatBlock, { kind: 'approval' }>;
  onResolve: (approvalId: string, decision: ApprovalDecision, note: string) => Promise<void>;
  disabled?: boolean;
}) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const status = block.localStatus ?? block.approval.status ?? 'pending';
  const pending = status === 'pending';
  const risk = block.approval.risk ?? 'medium';

  const resolve = async (decision: ApprovalDecision) => {
    setBusy(decision);
    try {
      await onResolve(block.approval.id, decision, note);
      toast(decision === 'approve' ? '已批准，提交结果见审计日志' : '已驳回，草稿保持未提交', 'ok');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : '审批失败', 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ra-approval" data-risk={risk === 'high' ? 'high' : 'medium'}>
      <div className="ra-approval-head">
        <span className="ra-approval-title">
          🔐 需要人工审批
          <span className={`ra-tag ${risk === 'high' ? 'ra-tag-danger' : 'ra-tag-warn'}`}>
            风险：{risk === 'high' ? '高' : risk === 'medium' ? '中' : String(risk)}
          </span>
          <span className="ra-chip">{block.approval.kind ?? 'order_commit'}</span>
        </span>
        <span className="ra-right">
          <span
            className={`ra-status ${
              status === 'approved' ? 'ra-status-ok' : status === 'rejected' ? 'ra-status-err' : 'ra-status-warn'
            }`}
          >
            <i className="ra-dot" aria-hidden="true" />
            {status === 'approved' ? '已批准' : status === 'rejected' ? '已驳回' : '待审批'}
          </span>
        </span>
      </div>

      <div className="ra-approval-body">
        <div className="ra-approval-summary">{block.approval.summary ?? '（无摘要）'}</div>
        <div className="ra-faint ra-xs">
          审批单号 {block.approval.id}
          {block.approval.draft_id ? ` · 关联草稿 ${block.approval.draft_id}` : ''}
          {block.approval.requested_by ? ` · 发起人 ${block.approval.requested_by}` : ''}
        </div>

        {pending ? (
          <div className="ra-approval-actions">
            <label className="ra-sr-only" htmlFor={`note-${block.id}`}>
              审批备注
            </label>
            <textarea
              id={`note-${block.id}`}
              className="ra-textarea"
              placeholder="备注（可选，会写入审计）"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={disabled || busy !== null}
            />
            <button
              type="button"
              className="ra-btn ra-btn-primary ra-btn-sm"
              onClick={() => void resolve('approve')}
              disabled={disabled || busy !== null}
            >
              {busy === 'approve' ? <span className="ra-spinner" aria-hidden="true" /> : null}
              批准并提交
            </button>
            <button
              type="button"
              className="ra-btn ra-btn-sm"
              onClick={() => void resolve('reject')}
              disabled={disabled || busy !== null}
            >
              {busy === 'reject' ? <span className="ra-spinner" aria-hidden="true" /> : null}
              驳回
            </button>
          </div>
        ) : (
          <div className="ra-approval-result">
            {status === 'approved'
              ? '已批准：正式单由服务端提交，结果见审计日志。'
              : '已驳回：草稿保留但不会提交。'}
            {block.localNote ? ` · 备注：${block.localNote}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

export interface ChatPanelProps {
  state: AgentSessionState;
  actions: AgentSessionActions;
}

export function ChatPanel({ state, actions }: ChatPanelProps) {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);

  const busy = state.status === 'connecting' || state.status === 'streaming';

  // 贴底滚动：用户上翻时不抢
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [state.blocks, state.status]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const submit = () => {
    const content = text.trim();
    if (content === '' || busy) return;
    setText('');
    stickRef.current = true;
    void actions.send(content);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      // 中文输入法组合中不发送
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      submit();
    }
  };

  const renderBlock = (block: ChatBlock) => {
    switch (block.kind) {
      case 'user':
        return (
          <div className="ra-msg ra-msg-user" key={block.id}>
            <div className="ra-msg-role">我</div>
            <div className="ra-bubble ra-bubble-user">{block.text}</div>
          </div>
        );
      case 'assistant':
        return (
          <div className="ra-msg" key={block.id}>
            <div className="ra-msg-role">助手</div>
            <div className={`ra-bubble ra-bubble-assistant${block.streaming ? ' ra-bubble-streaming' : ''}`}>
              {block.text || (block.streaming ? '正在生成…' : DASH)}
            </div>
          </div>
        );
      case 'reasoning':
        return (
          <details className="ra-reason" key={block.id}>
            <summary>
              <span className="ra-reason-caret" aria-hidden="true">
                ▶
              </span>
              思考过程
              <span className="ra-faint">{block.text.length} 字（可折叠）</span>
            </summary>
            <div className="ra-reason-body">{block.text}</div>
          </details>
        );
      case 'tool':
        return <ToolCard block={block} key={block.id} />;
      case 'approval':
        return (
          <ApprovalCard
            key={block.id}
            block={block}
            onResolve={actions.resolveApproval}
            disabled={busy}
          />
        );
      case 'error':
        return (
          <div className="ra-alert ra-alert-danger" role="alert" key={block.id}>
            <div className="ra-grow">
              <b>{block.code}</b>：{block.message}
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="ra-agent-left">
      <div className="ra-agent-head">
        <span className="ra-agent-head-title">
          <span aria-hidden="true">💬</span> 会话
        </span>
        <span className="ra-agent-head-meta">
          <span className="ra-mono" title={state.sessionId ?? undefined}>
            {state.sessionId ? truncate(state.sessionId, 18) : '新会话'}
          </span>
          <span className={`ra-status ${STATUS_TONE[state.status]}`}>
            <i className="ra-dot" aria-hidden="true" />
            {STATUS_TEXT[state.status]}
          </span>
          {state.step ? (
            <span className="ra-chip">
              step {state.step.step}/{state.step.max_steps}
            </span>
          ) : null}
        </span>
      </div>

      <div className="ra-chat-scroll" ref={scrollRef}>
        {state.loadingHistory ? (
          <div className="ra-loading-block">
            <span className="ra-spinner" aria-hidden="true" /> 正在加载会话历史…
          </div>
        ) : null}

        {state.historyError ? (
          <div className="ra-alert ra-alert-danger" role="alert">
            <div className="ra-grow">会话历史加载失败：{state.historyError}</div>
            <button type="button" className="ra-btn ra-btn-sm" onClick={() => void actions.reloadHistory()}>
              重试
            </button>
          </div>
        ) : null}

        {state.blocks.length === 0 && !state.loadingHistory ? (
          <div className="ra-empty" style={{ padding: '28px 12px' }}>
            <div className="ra-empty-icon" aria-hidden="true">
              🧭
            </div>
            <div className="ra-empty-title">从哪里开始？</div>
            <div style={{ lineHeight: 1.75, maxWidth: 420 }}>
              用自然语言描述补货需求。所有计算都走确定性工具（不由模型口算），写操作只产草稿，
              提交必须经过你审批。下面三个例子可直接点选：
            </div>
            <div className="ra-suggest-list" style={{ width: '100%', maxWidth: 460 }}>
              {SAMPLE_PROMPTS.map((prompt, index) => (
                <button
                  key={prompt}
                  type="button"
                  className="ra-suggest-prompt"
                  onClick={() => {
                    setText(prompt);
                    inputRef.current?.focus();
                  }}
                >
                  <b>{index + 1}.</b> {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {state.blocks.length > 0 ? <div className="ra-timeline">{state.blocks.map(renderBlock)}</div> : null}

        {busy ? (
          <div className="ra-row ra-gap-2 ra-dim ra-xs" role="status" aria-live="polite">
            <span className="ra-spinner" aria-hidden="true" />
            {state.status === 'connecting' ? '正在建立流式连接…' : '助手正在生成…'}
          </div>
        ) : null}
      </div>

      {state.error && state.status !== 'streaming' ? (
        <div className="ra-alert ra-alert-danger" role="alert" style={{ margin: '6px 12px' }}>
          <div className="ra-grow">
            <b>连接中断</b>（{state.error.code}）：{state.error.message}
            <div className="ra-hint ra-mt-2">
              SSE 断流后本轮不会自动续传。可「重发」同一句，或「重连」重新拉取会话历史。
            </div>
          </div>
          <div className="ra-row ra-gap-2">
            <button
              type="button"
              className="ra-btn ra-btn-sm"
              onClick={() => void actions.retry()}
              disabled={!state.lastUserText || busy}
              title={state.lastUserText ? '重发上一条消息' : '还没有可重发的消息'}
            >
              重发
            </button>
            <button type="button" className="ra-btn ra-btn-sm" onClick={() => void actions.reloadHistory()}>
              重连
            </button>
          </div>
        </div>
      ) : null}

      <div className="ra-composer">
        <div className="ra-composer-box">
          <label className="ra-sr-only" htmlFor="ra-agent-input">
            给补货助手发消息
          </label>
          <textarea
            id="ra-agent-input"
            ref={inputRef}
            value={text}
            placeholder="例如：按默认方案看看今天要补哪些货，只列低库存的"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
            rows={2}
            aria-describedby="ra-composer-hint"
          />
          <div className="ra-composer-bar">
            <span className="ra-faint ra-xs">
              写操作只产草稿 · 提交需审批
            </span>
            <span className="ra-composer-hint" id="ra-composer-hint">
              <span className="ra-kbd">Enter</span> 发送
              <span className="ra-kbd">Shift</span>+<span className="ra-kbd">Enter</span> 换行
            </span>
            <span className="ra-right" />
            {busy ? (
              <button type="button" className="ra-btn ra-btn-sm" onClick={actions.stop}>
                停止
              </button>
            ) : null}
            <button
              type="button"
              className="ra-btn ra-btn-primary ra-btn-sm"
              onClick={submit}
              disabled={busy || text.trim() === ''}
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 暴露给测试/调试：把 SSE 事件转成人类可读摘要（不参与渲染逻辑） */
export function describeSseEvent(event: SseEvent): string {
  switch (event.type) {
    case 'session':
      return `会话 ${event.session_id ?? ''}`;
    case 'step':
      return `第 ${event.step ?? '?'} / ${event.max_steps ?? '?'} 步`;
    case 'reasoning_delta':
      return `思考 +${(event.text ?? '').length} 字`;
    case 'assistant_delta':
      return `回答 +${(event.text ?? '').length} 字`;
    case 'tool_call':
      return `调用工具 ${event.name ?? ''}`;
    case 'tool_result':
      return `工具 ${event.name ?? ''} ${event.ok === false ? '失败' : '完成'}`;
    case 'artifact':
      return `产物 ${event.artifact?.title ?? event.artifact?.kind ?? ''}`;
    case 'approval_required':
      return `需要审批 ${event.approval?.id ?? ''}`;
    case 'usage':
      return `token ${event.prompt_tokens ?? 0}/${event.completion_tokens ?? 0}`;
    case 'error':
      return `错误 ${event.code ?? ''} ${event.message ?? ''}`;
    case 'done':
      return `结束（${event.finish_reason ?? ''}）`;
    default:
      return '未知事件';
  }
}
