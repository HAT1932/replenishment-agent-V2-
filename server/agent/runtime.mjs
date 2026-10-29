/**
 * runtime.mjs — 智能补货 Agent 运行时（会话轮次 / 多步工具循环 / 事件流 / 预算）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：contracts §5
 *
 *   createRuntime({ db, provider, tools, clock, limits }) -> runtime
 *   runtime.run({ sessionId, userMessage, onEvent, signal }) -> Promise<{ finish_reason, usage }>
 *
 * 硬约束（都有测试）：
 *  - MAX_STEPS=8、单轮工具调用 ≤12、单工具超时 20s、整轮预算 180s；
 *  - 超限/Provider 失败/取消：发 `error` 事件后**正常收尾**（必定发 done，绝不抛未捕获异常）；
 *  - 每次工具调用由 tools 注册表写双审计（tool_call + tool_result）；
 *  - 只通过 `signal` 支持外部取消（HTTP 层在客户端断开时 abort）。
 *
 * 事件协议（seq 单调递增）：
 *   session / step / reasoning_delta / assistant_delta / tool_call / tool_result /
 *   artifact / approval_required / usage / error / done
 */
import { buildSystemPrompt } from './prompts/system.mjs';
import { truncateForEvent, todayFromClock } from './tools/util.mjs';

export const MAX_STEPS = 8;
export const MAX_TOOL_CALLS_PER_TURN = 12;
export const TOOL_TIMEOUT_MS = 20000;
export const TURN_BUDGET_MS = 180000;

function safeJson(text) {
  if (typeof text !== 'string') return text ?? {};
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { __raw: text };
  }
}

/**
 * @param {{db: unknown, provider: object, tools: object, clock?: () => number,
 *          limits?: {maxSteps?: number, maxToolCallsPerTurn?: number, toolTimeoutMs?: number,
 *                    turnBudgetMs?: number}, repository?: object, domain?: object,
 *          systemPrompt?: string}} input
 */
export function createRuntime({ db, provider, tools, clock = () => Date.now(), limits = {}, repository, domain, systemPrompt }) {
  if (!provider || typeof provider.chat !== 'function') throw new Error('createRuntime 需要 provider.chat');
  if (!tools || typeof tools.execute !== 'function') throw new Error('createRuntime 需要 tools 注册表');

  const cfg = {
    maxSteps: limits.maxSteps ?? MAX_STEPS,
    maxToolCallsPerTurn: limits.maxToolCallsPerTurn ?? MAX_TOOL_CALLS_PER_TURN,
    toolTimeoutMs: limits.toolTimeoutMs ?? TOOL_TIMEOUT_MS,
    turnBudgetMs: limits.turnBudgetMs ?? TURN_BUDGET_MS,
  };
  const repo = repository ?? tools.repository ?? null;
  /** @type {Map<string, Array<object>>} 进程内会话转录（断言/回放用；同时尽力持久化） */
  const transcripts = new Map();

  async function today() {
    try {
      if (repo && typeof repo.getMeta === 'function') {
        const meta = await repo.getMeta(db);
        if (meta?.today) return String(meta.today);
      }
    } catch {
      /* 降级到时钟推导 */
    }
    return todayFromClock(clock);
  }

  async function loadHistory(sessionId, explicit) {
    if (Array.isArray(explicit)) return explicit.map((m) => ({ ...m }));
    if (transcripts.has(sessionId)) return transcripts.get(sessionId).map((m) => ({ ...m }));
    let rows = [];
    try {
      if (repo && typeof repo.listMessages === 'function') {
        rows = (await repo.listMessages(db, sessionId)) ?? [];
      }
    } catch {
      rows = [];
    }
    const messages = [];
    for (const row of rows) {
      if (!row) continue;
      const msg = normalizeStoredMessage(row);
      if (msg) messages.push(msg);
    }
    transcripts.set(sessionId, messages);
    return messages.map((m) => ({ ...m }));
  }

  async function persistMessage(sessionId, message) {
    if (!transcripts.has(sessionId)) transcripts.set(sessionId, []);
    transcripts.get(sessionId).push(message);
    try {
      if (repo && typeof repo.appendMessage === 'function') {
        await repo.appendMessage(db, {
          session_id: sessionId,
          ...message,
          content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
        });
      }
    } catch {
      /* 持久化失败不阻断本轮；审计与会话内回放仍然可用 */
    }
  }

  /**
   * 跑一轮对话。
   * @param {{sessionId: string, userMessage: string, onEvent?: (e: object) => void,
   *          signal?: AbortSignal, history?: Array<object>}} input
   * @returns {Promise<{finish_reason: string, usage: {prompt_tokens:number, completion_tokens:number,
   *          reasoning_tokens:number}, steps: number, tool_calls: number, session_id: string}>}
   */
  async function run({ sessionId, userMessage, onEvent, signal, history } = {}) {
    if (!sessionId) throw new Error('run 需要 sessionId');
    const emitRaw = typeof onEvent === 'function' ? onEvent : () => {};
    let seq = 0;
    /** 事件发送器：seq 单调递增，回调异常不影响运行时 */
    const emit = (event) => {
      const payload = { seq: ++seq, ...event };
      try {
        emitRaw(payload);
      } catch {
        /* 消费方异常不应打断 Agent */
      }
      return payload;
    };
    const startedAt = clock();
    const usage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 };
    let finishReason = null;
    let steps = 0;
    let toolCallCount = 0;
    let errorInfo = null;

    const emitError = (code, message) => {
      errorInfo = { code, message };
      emit({ type: 'error', code, message });
    };

    emit({ type: 'session', session_id: sessionId });

    const messages = await loadHistory(sessionId, history);
    const systemMessage = {
      role: 'system',
      content: systemPrompt ?? buildSystemPrompt({ today: await today(), provider: provider.name, model: provider.model }),
    };
    const userMsg = { role: 'user', content: String(userMessage ?? '') };
    messages.push(userMsg);
    await persistMessage(sessionId, userMsg);
    const modelTools = typeof tools.toModelTools === 'function' ? tools.toModelTools() : [];
    const elapsed = () => clock() - startedAt;

    try {
      outer: for (let step = 1; step <= cfg.maxSteps; step += 1) {
        if (signal?.aborted) {
          emitError('INTERNAL', '本轮已被取消');
          finishReason = 'aborted';
          break;
        }
        if (elapsed() > cfg.turnBudgetMs) {
          emitError('TURN_BUDGET_EXCEEDED', `整轮预算 ${cfg.turnBudgetMs}ms 已用尽`);
          finishReason = 'turn_budget';
          break;
        }
        steps = step;
        emit({ type: 'step', step, max_steps: cfg.maxSteps });

        // ---- 调模型（流式：reasoning 与 content 分开发事件）----
        let response;
        try {
          response = await provider.chat({
            messages: [systemMessage, ...messages],
            tools: modelTools,
            toolChoice: 'auto',
            signal,
            sessionId,
            step,
            onDelta: (delta) => {
              if (!delta?.text) return;
              if (delta.type === 'reasoning') emit({ type: 'reasoning_delta', text: delta.text });
              else emit({ type: 'assistant_delta', text: delta.text });
            },
          });
        } catch (err) {
          if (signal?.aborted) {
            emitError('INTERNAL', '本轮已被取消');
            finishReason = 'aborted';
          } else {
            const code = err?.code === 'UPSTREAM_LLM_ERROR' ? 'UPSTREAM_LLM_ERROR' : 'INTERNAL';
            emitError(code, err instanceof Error ? err.message : String(err));
            finishReason = 'error';
          }
          break;
        }
        if (!response || !response.message) {
          emitError('UPSTREAM_LLM_ERROR', 'Provider 未返回有效消息');
          finishReason = 'error';
          break;
        }
        mergeUsage(usage, response.usage);

        const assistant = normalizeAssistant(response.message);
        messages.push(assistant);
        await persistMessage(sessionId, assistant);

        const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
        if (!calls.length) {
          finishReason = 'stop';
          break;
        }

        for (const call of calls) {
          if (signal?.aborted) {
            emitError('INTERNAL', '本轮已被取消');
            finishReason = 'aborted';
            break outer;
          }
          if (toolCallCount >= cfg.maxToolCallsPerTurn) {
            emitError('TOOL_CALL_BUDGET_EXCEEDED', `单轮工具调用上限 ${cfg.maxToolCallsPerTurn} 已用尽`);
            finishReason = 'tool_budget';
            break outer;
          }
          if (elapsed() > cfg.turnBudgetMs) {
            emitError('TURN_BUDGET_EXCEEDED', `整轮预算 ${cfg.turnBudgetMs}ms 已用尽`);
            finishReason = 'turn_budget';
            break outer;
          }
          toolCallCount += 1;
          const name = call.function?.name ?? '';
          const canonical = tools.canonicalName?.(name) ?? name;
          const args = safeJson(call.function?.arguments);
          const callId = call.id ?? `call_${step}_${toolCallCount}`;
          emit({ type: 'tool_call', call_id: callId, name: canonical, args, step });

          const envelope = await tools.execute(name, args, {
            sessionId,
            step,
            callId,
            signal,
            actor: 'agent',
          });

          const resultEvent = {
            type: 'tool_result',
            call_id: callId,
            name: canonical,
            ok: envelope.ok === true,
            duration_ms: envelope.meta?.duration_ms ?? 0,
            summary: envelope.ok
              ? envelope.meta?.summary ?? summarizeData(envelope.data)
              : envelope.error?.message ?? '工具调用失败',
            provenance: envelope.meta?.provenance ?? null,
            assumptions: envelope.meta?.assumptions ?? [],
          };
          if (envelope.ok) {
            const { data } = truncateForEvent(envelope.data, 8192);
            resultEvent.data = data;
          } else {
            resultEvent.error = envelope.error;
            if (envelope.error?.code) resultEvent.code = envelope.error.code;
          }
          emit(resultEvent);

          // ---- artifact 事件（建议表 / 草稿 / 解释）----
          for (const artifact of envelope.meta?.artifacts ?? []) {
            // 先落库（数据层生成稳定 id），再发事件：刷新会话也能从 artifacts 表还原
            let stored = null;
            try {
              if (repo && typeof repo.saveArtifact === 'function') {
                stored = await repo.saveArtifact(db, {
                  session_id: sessionId,
                  kind: artifact.kind ?? 'unknown',
                  title: artifact.title ?? '',
                  content: artifact.ref ?? null,
                });
              }
            } catch {
              /* artifact 持久化失败不阻断；事件仍会发出 */
            }
            const record = {
              id: artifact.id ?? stored?.id ?? stored?.artifact_id ?? `art_${seq + 1}`,
              kind: artifact.kind ?? 'unknown',
              title: artifact.title ?? '',
              ref: artifact.ref ?? null,
            };
            emit({ type: 'artifact', artifact: record });
          }

          // ---- approval_required 事件（草稿创建后自动产生的审批请求）----
          if (envelope.meta?.approval) {
            const approval = envelope.meta.approval;
            emit({
              type: 'approval_required',
              approval: {
                id: approval.id,
                kind: approval.kind ?? 'order_commit',
                summary: approval.summary ?? '',
                risk: approval.risk ?? 'medium',
                ref: approval.ref ?? { draft_id: approval.draft_id ?? null },
                status: approval.status ?? 'pending',
              },
            });
          }

          const toolMessage = {
            role: 'tool',
            tool_call_id: callId,
            name: canonical,
            content: JSON.stringify({
              ok: envelope.ok,
              ...(envelope.ok ? { data: envelope.data, meta: stripInternalMeta(envelope.meta) } : { error: envelope.error }),
            }),
          };
          messages.push(toolMessage);
          await persistMessage(sessionId, toolMessage);
        }
      }
      if (!finishReason) {
        emitError('MAX_STEPS_EXCEEDED', `已达最大步数 ${cfg.maxSteps}，提前收尾`);
        finishReason = 'max_steps';
      }
    } catch (err) {
      // 兜底：任何未预期异常都必须转成 error 事件，不能冒泡成 500
      emitError('INTERNAL', err instanceof Error ? err.message : String(err));
      finishReason = 'error';
    }

    emit({ type: 'usage', ...usage });
    emit({ type: 'done', finish_reason: finishReason ?? 'error' });
    return {
      finish_reason: finishReason ?? 'error',
      usage,
      steps,
      tool_calls: toolCallCount,
      session_id: sessionId,
      ...(errorInfo ? { error: errorInfo } : {}),
    };
  }

  return {
    run,
    config: { ...cfg },
    provider: { name: provider.name, model: provider.model, supportsStreaming: provider.supportsStreaming === true },
    tools,
    db,
    repository: repo,
    domain,
    deps: tools.deps,
    /** 测试/调试：读取进程内转录 */
    transcript(sessionId) {
      return (transcripts.get(sessionId) ?? []).map((m) => ({ ...m }));
    },
  };
}

function normalizeAssistant(message) {
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .filter((c) => c && typeof c === 'object')
        .map((c, index) => ({
          id: c.id ?? `call_${index + 1}`,
          type: c.type ?? 'function',
          function: {
            name: c.function?.name ?? c.name ?? '',
            arguments:
              typeof c.function?.arguments === 'string'
                ? c.function.arguments
                : JSON.stringify(c.function?.arguments ?? {}),
          },
        }))
    : undefined;
  return {
    role: 'assistant',
    content: typeof message.content === 'string' ? message.content : '',
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    ...(toolCalls && toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function normalizeStoredMessage(row) {
  const role = row.role;
  if (!role) return null;
  const content = typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? '');
  if (role === 'assistant') {
    let toolCalls = row.tool_calls;
    if (typeof toolCalls === 'string') {
      try {
        toolCalls = JSON.parse(toolCalls);
      } catch {
        toolCalls = undefined;
      }
    }
    return {
      role: 'assistant',
      content,
      ...(row.reasoning_content ? { reasoning_content: row.reasoning_content } : {}),
      ...(Array.isArray(toolCalls) && toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
  }
  if (role === 'tool') {
    return { role: 'tool', tool_call_id: row.tool_call_id ?? row.call_id ?? null, content, ...(row.name ? { name: row.name } : {}) };
  }
  if (role === 'user' || role === 'system') return { role, content };
  return null;
}

function mergeUsage(target, usage) {
  if (!usage || typeof usage !== 'object') return;
  target.prompt_tokens += Number(usage.prompt_tokens ?? 0) || 0;
  target.completion_tokens += Number(usage.completion_tokens ?? 0) || 0;
  target.reasoning_tokens += Number(usage.reasoning_tokens ?? 0) || 0;
}

function summarizeData(data) {
  try {
    const text = JSON.stringify(data);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return String(data);
  }
}

/** tool 消息里不需要把 artifacts 重复塞进上下文；approval 必须保留（模型要知道"待审批"以及审批 id） */
function stripInternalMeta(meta) {
  if (!meta) return {};
  const { artifacts, ...rest } = meta;
  return rest;
}
