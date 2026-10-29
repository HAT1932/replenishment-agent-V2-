/**
 * useAgentSession.ts — SSE 状态机（契约 §5）
 *
 * 职责：
 *  - 维护消息块时间线（用户 / 助手 / 思考 / 工具 / 审批 / 错误），按事件到达顺序追加；
 *  - 处理 `seq` 计数、`call_id` 关联（tool_call → tool_result 回填同一张卡片）；
 *  - 支持 abort（停止生成）、重发（断流后重试同一句）、加载历史会话；
 *  - 一切数值（usage / step / 建议数）都来自事件，前端不推算。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost, errorCode, errorMessage } from '../../lib/api';
import { streamSse } from '../../lib/sse';
import type {
  Approval,
  ApprovalDecision,
  Artifact,
  ChatBlock,
  SessionDetail,
  SessionMessage,
  SseEvent,
  UsageInfo,
  StreamStatus,
} from '../../app/types';

const EMPTY_USAGE: UsageInfo = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 };

let blockSeq = 0;
function nextBlockId(prefix: string): string {
  blockSeq += 1;
  return `${prefix}-${blockSeq}`;
}

export interface AgentSessionState {
  sessionId: string | null;
  blocks: ChatBlock[];
  status: StreamStatus;
  usage: UsageInfo;
  step: { step: number; max_steps: number } | null;
  error: { code: string; message: string } | null;
  artifacts: Artifact[];
  approvals: Approval[];
  lastUserText: string | null;
  /** 历史会话加载失败/加载中 */
  loadingHistory: boolean;
  historyError: string | null;
}

export interface AgentSessionActions {
  send: (text: string) => Promise<void>;
  stop: () => void;
  retry: () => Promise<void>;
  reloadHistory: () => Promise<void>;
  resolveApproval: (approvalId: string, decision: ApprovalDecision, note: string) => Promise<void>;
  /** 外部 artifact（如建议面板新产物）注入 */
  pushArtifact: (artifact: Artifact) => void;
}

function messageToBlocks(message: SessionMessage): ChatBlock[] {
  const role = message.role ?? 'assistant';
  const text = message.content ?? message.text ?? '';
  if (role === 'user') {
    return [{ kind: 'user', id: nextBlockId('h-user'), text, ts: message.ts ?? message.created_at }];
  }
  if (role === 'tool') {
    return [
      {
        kind: 'tool',
        id: nextBlockId('h-tool'),
        callId: `hist-${nextBlockId('call')}`,
        name: message.tool_name ?? 'tool',
        args: message.tool_calls ?? null,
        status: message.ok === false ? 'error' : 'done',
        result: { ok: message.ok !== false, summary: text.length > 240 ? `${text.slice(0, 240)}…` : text },
      },
    ];
  }
  if (role === 'assistant' || role === 'system') {
    const blocks: ChatBlock[] = [];
    if (message.reasoning) blocks.push({ kind: 'reasoning', id: nextBlockId('h-reason'), text: message.reasoning });
    if (text) blocks.push({ kind: 'assistant', id: nextBlockId('h-assist'), text, streaming: false });
    return blocks;
  }
  return [];
}

export function useAgentSession(initialSessionId: string | null): AgentSessionState & AgentSessionActions {
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const [blocks, setBlocks] = useState<ChatBlock[]>([]);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [usage, setUsage] = useState<UsageInfo>(EMPTY_USAGE);
  const [step, setStep] = useState<{ step: number; max_steps: number } | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [lastUserText, setLastUserText] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<string | null>(initialSessionId);
  sessionRef.current = sessionId;
  /** 当前流式轮次的块 id（reasoning / assistant 需持续追加到同一块） */
  const turnRef = useRef<{ reasoningId: string | null; assistantId: string | null }>({
    reasoningId: null,
    assistantId: null,
  });

  /** 按 call_id 回填工具结果；找不到则补一张卡片（防御服务端事件顺序异常） */
  const applyToolResult = useCallback((event: SseEvent) => {
    const callId = event.call_id ?? '';
    const result = {
      ok: event.ok !== false,
      duration_ms: event.duration_ms,
      summary: event.summary,
      data: event.data,
      errorCode: typeof event.error === 'object' && event.error ? event.error.code : undefined,
      errorMessage:
        typeof event.error === 'string'
          ? event.error
          : typeof event.error === 'object' && event.error
            ? event.error.message
            : undefined,
    };
    setBlocks((prev) => {
      const index = prev.findIndex((block) => block.kind === 'tool' && block.callId === callId);
      if (index < 0) {
        return [
          ...prev,
          {
            kind: 'tool',
            id: nextBlockId('tool'),
            callId: callId || nextBlockId('call'),
            name: event.name ?? 'tool',
            args: null,
            status: result.ok ? 'done' : 'error',
            result,
          },
        ];
      }
      const next = [...prev];
      const current = next[index];
      if (current?.kind === 'tool') {
        next[index] = { ...current, status: result.ok ? 'done' : 'error', result };
      }
      return next;
    });
  }, []);

  const handleEvent = useCallback(
    (event: SseEvent) => {
      switch (event.type) {
        case 'session': {
          if (event.session_id) {
            setSessionId(event.session_id);
            sessionRef.current = event.session_id;
          }
          break;
        }
        case 'step': {
          if (typeof event.step === 'number') {
            setStep({ step: event.step, max_steps: event.max_steps ?? 8 });
          }
          break;
        }
        case 'reasoning_delta': {
          const text = event.text ?? '';
          setBlocks((prev) => {
            const id = turnRef.current.reasoningId;
            if (id) {
              const index = prev.findIndex((block) => block.kind === 'reasoning' && block.id === id);
              if (index >= 0) {
                const next = [...prev];
                const current = next[index];
                if (current?.kind === 'reasoning') {
                  next[index] = { ...current, text: current.text + text };
                }
                return next;
              }
            }
            const newId = nextBlockId('reason');
            turnRef.current.reasoningId = newId;
            return [...prev, { kind: 'reasoning', id: newId, text }];
          });
          break;
        }
        case 'assistant_delta': {
          const text = event.text ?? '';
          setBlocks((prev) => {
            const id = turnRef.current.assistantId;
            if (id) {
              const index = prev.findIndex((block) => block.kind === 'assistant' && block.id === id);
              if (index >= 0) {
                const next = [...prev];
                const current = next[index];
                if (current?.kind === 'assistant') {
                  next[index] = { ...current, text: current.text + text };
                }
                return next;
              }
            }
            const newId = nextBlockId('assist');
            turnRef.current.assistantId = newId;
            return [...prev, { kind: 'assistant', id: newId, text, streaming: true }];
          });
          break;
        }
        case 'tool_call': {
          setBlocks((prev) => [
            ...prev,
            {
              kind: 'tool',
              id: nextBlockId('tool'),
              callId: event.call_id ?? nextBlockId('call'),
              name: event.name ?? 'tool',
              args: event.args ?? null,
              step: event.step,
              status: 'running',
            },
          ]);
          break;
        }
        case 'tool_result': {
          applyToolResult(event);
          break;
        }
        case 'artifact': {
          if (event.artifact) {
            const artifact = event.artifact;
            setArtifacts((prev) => (prev.some((item) => item.id === artifact.id) ? prev : [...prev, artifact]));
          }
          break;
        }
        case 'approval_required': {
          if (event.approval) {
            const approval = event.approval;
            setApprovals((prev) => (prev.some((item) => item.id === approval.id) ? prev : [...prev, approval]));
            setBlocks((prev) => [
              ...prev,
              { kind: 'approval', id: nextBlockId('approval'), approval, localStatus: approval.status ?? 'pending' },
            ]);
          }
          break;
        }
        case 'usage': {
          setUsage({
            prompt_tokens: event.prompt_tokens ?? 0,
            completion_tokens: event.completion_tokens ?? 0,
            reasoning_tokens: event.reasoning_tokens ?? 0,
          });
          break;
        }
        case 'error': {
          setError({ code: event.code ?? 'INTERNAL', message: event.message ?? '未知错误' });
          setBlocks((prev) => [
            ...prev,
            {
              kind: 'error',
              id: nextBlockId('err'),
              code: event.code ?? 'INTERNAL',
              message: event.message ?? '未知错误',
            },
          ]);
          break;
        }
        case 'done': {
          setStatus('done');
          setBlocks((prev) =>
            prev.map((block) => (block.kind === 'assistant' ? { ...block, streaming: false } : block)),
          );
          break;
        }
        default:
          break;
      }
    },
    [applyToolResult],
  );

  /** 把流式块标记为结束（abort / 网络中断） */
  const finalizeBlocks = useCallback(() => {
    setBlocks((prev) =>
      prev.map((block) => {
        if (block.kind === 'assistant') return { ...block, streaming: false };
        if (block.kind === 'tool' && block.status === 'running') {
          return { ...block, status: 'error', result: { ok: false, errorMessage: '流已中断' } };
        }
        return block;
      }),
    );
  }, []);

  const stream = useCallback(
    async (targetSessionId: string, content: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      turnRef.current = { reasoningId: null, assistantId: null };
      setError(null);
      setStep(null);
      setStatus('connecting');

      try {
        await streamSse({
          path: `/sessions/${encodeURIComponent(targetSessionId)}/messages`,
          body: { content },
          signal: controller.signal,
          onOpen: () => setStatus('streaming'),
          onEvent: handleEvent,
        });
        if (!controller.signal.aborted) setStatus('done');
      } catch (e: unknown) {
        if (controller.signal.aborted || errorCode(e) === 'ABORTED') {
          setStatus('aborted');
          finalizeBlocks();
          return;
        }
        const message = errorMessage(e);
        const code = errorCode(e) ?? 'NETWORK_ERROR';
        setError({ code, message });
        setStatus('error');
        setBlocks((prev) => [
          ...prev,
          { kind: 'error', id: nextBlockId('err'), code, message },
        ]);
        finalizeBlocks();
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [finalizeBlocks, handleEvent],
  );

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (content === '') return;
      setLastUserText(content);
      setBlocks((prev) => [...prev, { kind: 'user', id: nextBlockId('user'), text: content }]);
      setStatus('connecting');
      setError(null);

      let targetSessionId = sessionRef.current;
      if (!targetSessionId) {
        try {
          const created = await apiPost<{ session_id?: string; id?: string }>('/sessions', {
            title: content.slice(0, 30),
          });
          targetSessionId = created?.session_id ?? created?.id ?? null;
          if (!targetSessionId) throw new Error('创建会话失败：后端未返回 session_id');
          setSessionId(targetSessionId);
          sessionRef.current = targetSessionId;
        } catch (e: unknown) {
          const message = errorMessage(e);
          setError({ code: errorCode(e) ?? 'NETWORK_ERROR', message });
          setStatus('error');
          setBlocks((prev) => [
            ...prev,
            { kind: 'error', id: nextBlockId('err'), code: errorCode(e) ?? 'NETWORK_ERROR', message },
          ]);
          return;
        }
      }
      await stream(targetSessionId, content);
    },
    [stream],
  );

  const retry = useCallback(async () => {
    const text = lastUserText;
    if (!text) return;
    const targetSessionId = sessionRef.current;
    if (!targetSessionId) {
      await send(text);
      return;
    }
    // 重发不重复插入用户气泡
    turnRef.current = { reasoningId: null, assistantId: null };
    await stream(targetSessionId, text);
  }, [lastUserText, send, stream]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('aborted');
    finalizeBlocks();
  }, [finalizeBlocks]);

  const loadHistory = useCallback(async (targetSessionId: string | null) => {
    if (!targetSessionId) {
      setBlocks([]);
      setArtifacts([]);
      setApprovals([]);
      setUsage(EMPTY_USAGE);
      setError(null);
      setStatus('idle');
      return;
    }
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const detail = await apiGet<SessionDetail>(`/sessions/${encodeURIComponent(targetSessionId)}`);
      const messages = detail?.messages ?? [];
      const restored: ChatBlock[] = [];
      for (const message of messages) restored.push(...messageToBlocks(message));
      setBlocks(restored);
      setArtifacts(detail?.artifacts ?? []);
      setApprovals((detail?.artifacts ?? []).length >= 0 ? [] : []);
      setStatus('idle');
      setError(null);
    } catch (e: unknown) {
      setHistoryError(errorMessage(e));
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  const reloadHistory = useCallback(async () => {
    await loadHistory(sessionRef.current);
  }, [loadHistory]);

  // 初始会话 / URL 会话变化时加载历史（正在流式时不打断）
  useEffect(() => {
    if (status === 'connecting' || status === 'streaming') return;
    if (initialSessionId === sessionRef.current && blocks.length > 0) return;
    if (initialSessionId === null && sessionRef.current === null) return;
    sessionRef.current = initialSessionId;
    setSessionId(initialSessionId);
    void loadHistory(initialSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId]);

  const resolveApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision, note: string) => {
      const targetSessionId = sessionRef.current;
      if (!targetSessionId) return;
      setBlocks((prev) =>
        prev.map((block) =>
          block.kind === 'approval' && block.approval.id === approvalId
            ? { ...block, localStatus: decision === 'approve' ? 'approved' : 'rejected', localNote: note }
            : block,
        ),
      );
      try {
        const result = await apiPost<{ approval?: Approval; result?: unknown }>(
          `/sessions/${encodeURIComponent(targetSessionId)}/approvals/${encodeURIComponent(approvalId)}`,
          { decision, note },
        );
        setApprovals((prev) =>
          prev.map((item) =>
            item.id === approvalId
              ? { ...item, status: decision === 'approve' ? 'approved' : 'rejected', note, result: result?.result }
              : item,
          ),
        );
      } catch (e: unknown) {
        setError({ code: errorCode(e) ?? 'INTERNAL', message: errorMessage(e) });
        setBlocks((prev) => [
          ...prev,
          { kind: 'error', id: nextBlockId('err'), code: errorCode(e) ?? 'INTERNAL', message: errorMessage(e) },
        ]);
      }
    },
    [],
  );

  const pushArtifact = useCallback((artifact: Artifact) => {
    setArtifacts((prev) => (prev.some((item) => item.id === artifact.id) ? prev : [...prev, artifact]));
  }, []);

  // 卸载时 abort，避免内存泄漏与幽灵状态更新
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  return useMemo(
    () => ({
      sessionId,
      blocks,
      status,
      usage,
      step,
      error,
      artifacts,
      approvals,
      lastUserText,
      loadingHistory,
      historyError,
      send,
      stop,
      retry,
      reloadHistory,
      resolveApproval,
      pushArtifact,
    }),
    [
      sessionId,
      blocks,
      status,
      usage,
      step,
      error,
      artifacts,
      approvals,
      lastUserText,
      loadingHistory,
      historyError,
      send,
      stop,
      retry,
      reloadHistory,
      resolveApproval,
      pushArtifact,
    ],
  );
}
