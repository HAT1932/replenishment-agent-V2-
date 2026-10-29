/**
 * deepseek.mjs — DeepSeek（OpenAI 兼容）Provider
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 *
 * 能力与约束：
 *  - 流式 SSE：delta.content 与 delta.reasoning_content **分开**通过 onDelta 流出；
 *  - tool_calls：按 index 累积 id/name/arguments 增量，拼成完整调用；
 *  - 非流式回退：stream:false 或显式 {stream:false}；
 *  - 重试：429 / 5xx / 网络错误，最多 2 次，指数退避；4xx（含 400）不重试（除 stream_options 兼容回退）；
 *  - 超时：请求级 AbortController；调用方 signal 取消优先；
 *  - 错误映射为 ProviderError(code='UPSTREAM_LLM_ERROR')，**绝不透出 API key**。
 *
 * 自测方式：用注入的 fetchImpl 构造假 SSE（不联网）。
 */

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, status?: number|null, retryable?: boolean,
   *          details?: unknown, cause?: unknown}} [extra]
   */
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = extra.code ?? 'UPSTREAM_LLM_ERROR';
    this.status = extra.status ?? null;
    this.retryable = extra.retryable === true;
    this.details = extra.details;
    if (extra.cause) this.cause = extra.cause;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mapUsage(usage) {
  return {
    prompt_tokens: Number(usage?.prompt_tokens ?? 0) || 0,
    completion_tokens: Number(usage?.completion_tokens ?? 0) || 0,
    reasoning_tokens:
      Number(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? 0) || 0,
  };
}

/** 历史消息清洗：不把 reasoning_content 回传给服务端（DeepSeek 不要求且可能报错） */
function buildMessages(messages) {
  return (messages ?? [])
    .filter((m) => m && m.role)
    .map((m) => {
      if (m.role === 'assistant') {
        const out = {
          role: 'assistant',
          content: m.content && String(m.content).length > 0 ? m.content : null,
        };
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
        return out;
      }
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id ?? undefined,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        };
      }
      return { role: m.role, content: m.content ?? '' };
    });
}

function retryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * @param {{baseUrl?: string, apiKey?: string, model?: string, timeoutMs?: number,
 *          maxOutputTokens?: number, effort?: string, fetchImpl?: Function,
 *          retries?: number, retryBaseMs?: number, stream?: boolean}} [opts]
 */
export function createDeepseekProvider(opts = {}) {
  const baseUrl = String(opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;
  const apiKey = opts.apiKey ?? '';
  const model = opts.model ?? 'deepseek-flash';
  const timeoutMs = opts.timeoutMs ?? 120000;
  const maxOutputTokens = opts.maxOutputTokens ?? 4096;
  const effort = opts.effort ? String(opts.effort) : '';
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const retries = Math.max(0, Math.min(2, opts.retries ?? 2));
  const retryBaseMs = opts.retryBaseMs ?? 500;
  const defaultStream = opts.stream !== false;

  function assertReady() {
    if (!apiKey) {
      throw new ProviderError('缺少 LLM_API_KEY，无法调用 DeepSeek；请配置 .env 或使用 provider=mock', {
        retryable: false,
      });
    }
    if (typeof fetchImpl !== 'function') {
      throw new ProviderError('当前运行环境没有 fetch，无法调用 DeepSeek', { retryable: false });
    }
  }

  function buildBody(messages, tools, toolChoice, stream, includeUsage) {
    const body = {
      model,
      messages: buildMessages(messages),
      max_tokens: maxOutputTokens,
      stream,
    };
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools;
      body.tool_choice = toolChoice ?? 'auto';
    }
    if (stream && includeUsage) body.stream_options = { include_usage: true };
    if (effort) body.reasoning_effort = effort;
    return body;
  }

  /** 发请求，负责超时与取消；返回 Response */
  async function send(body, signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      return await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: body.stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new ProviderError('请求已被取消', { retryable: false, cause: err });
      }
      if (controller.signal.aborted) {
        throw new ProviderError(`DeepSeek 请求超时（${timeoutMs}ms）`, { retryable: false, cause: err });
      }
      throw new ProviderError(`无法连接 DeepSeek：${err?.message ?? err}`, { retryable: true, cause: err });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async function readErrorBody(res) {
    try {
      const text = await res.text();
      return text.length > 800 ? `${text.slice(0, 800)}…` : text;
    } catch {
      return '';
    }
  }

  /** 非流式请求 */
  async function requestOnce(messages, tools, toolChoice, signal, onDelta) {
    const res = await send(buildBody(messages, tools, toolChoice, false, false), signal);
    if (!res.ok) {
      const status = res.status;
      const detail = await readErrorBody(res);
      throw new ProviderError(`DeepSeek 返回 HTTP ${status}`, {
        status,
        retryable: retryableStatus(status),
        details: detail,
      });
    }
    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new ProviderError('DeepSeek 返回的不是合法 JSON', { retryable: false, cause: err });
    }
    const choice = json?.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const content = typeof message.content === 'string' ? message.content : '';
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
    if (typeof onDelta === 'function') {
      if (reasoning) safeDelta(onDelta, { type: 'reasoning', text: reasoning });
      if (content) safeDelta(onDelta, { type: 'content', text: content });
    }
    return {
      message: {
        role: 'assistant',
        content,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(Array.isArray(message.tool_calls) && message.tool_calls.length
          ? { tool_calls: message.tool_calls }
          : {}),
      },
      usage: mapUsage(json?.usage),
      finish_reason: choice.finish_reason ?? null,
    };
  }

  /** 流式请求（可兼容回退：400 时去掉 stream_options 重试一次） */
  async function requestStream(messages, tools, toolChoice, signal, onDelta, includeUsage = true) {
    const res = await send(buildBody(messages, tools, toolChoice, true, includeUsage), signal);
    if (!res.ok) {
      const status = res.status;
      const detail = await readErrorBody(res);
      if (status === 400 && includeUsage) {
        // 部分兼容端点不认 stream_options：去掉后重试一次（不消耗通用重试次数）
        return requestStream(messages, tools, toolChoice, signal, onDelta, false);
      }
      throw new ProviderError(`DeepSeek 返回 HTTP ${status}`, {
        status,
        retryable: retryableStatus(status),
        details: detail,
      });
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new ProviderError('DeepSeek 响应没有可读的 SSE 流', { retryable: false });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let usage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 };
    let finishReason = null;
    /** @type {Map<number, {id?:string, name:string, arguments:string}>} */
    const toolCalls = new Map();
    let sawDone = false;

    const handleBlock = (block) => {
      for (const rawLine of block.split('\n')) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // 容忍心跳/非 JSON 行
        }
        if (chunk.usage) usage = mapUsage(chunk.usage);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          safeDelta(onDelta, { type: 'reasoning', text: delta.reasoning_content });
        }
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          safeDelta(onDelta, { type: 'content', text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const part of delta.tool_calls) {
            const index = Number.isInteger(part.index) ? part.index : toolCalls.size;
            const current = toolCalls.get(index) ?? { name: '', arguments: '', id: undefined };
            if (part.id) current.id = part.id;
            if (part.function?.name) current.name += part.function.name;
            if (part.function?.arguments) current.arguments += part.function.arguments;
            toolCalls.set(index, current);
          }
        }
      }
    };

    try {
      for (;;) {
        if (signal?.aborted) {
          throw new ProviderError('请求已被取消', { retryable: false });
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (block.includes('[DONE]')) {
            sawDone = true;
            handleBlock(block);
            buffer = '';
            break;
          }
          handleBlock(block);
        }
        if (sawDone) break;
      }
      if (!sawDone && buffer.trim()) handleBlock(buffer);
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        /* ignore */
      }
    }

    const calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        id: call.id ?? `call_${index + 1}`,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
      }));

    return {
      message: {
        role: 'assistant',
        content,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      usage,
      finish_reason: finishReason,
    };
  }

  async function chat({ messages, tools, toolChoice, signal, onDelta, stream } = {}) {
    assertReady();
    const useStream = stream === undefined ? defaultStream : stream !== false;
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return useStream
          ? await requestStream(messages, tools, toolChoice, signal, onDelta, true)
          : await requestOnce(messages, tools, toolChoice, signal, onDelta);
      } catch (err) {
        lastError = err instanceof ProviderError
          ? err
          : new ProviderError(err?.message ?? String(err), { retryable: false, cause: err });
        if (!lastError.retryable || attempt >= retries || signal?.aborted) break;
        await sleep(retryBaseMs * 2 ** attempt);
      }
    }
    throw lastError ?? new ProviderError('DeepSeek 调用失败', { retryable: false });
  }

  return {
    name: 'deepseek',
    model,
    supportsStreaming: true,
    endpoint,
    chat,
  };
}

function safeDelta(onDelta, delta) {
  if (typeof onDelta !== 'function') return;
  try {
    onDelta(delta);
  } catch {
    /* 消费方异常不应中断流 */
  }
}
