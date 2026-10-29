/**
 * sse.ts — `text/event-stream` 客户端（契约 §5）
 *
 * 用 fetch + ReadableStream 手工解析（EventSource 不支持 POST 且无法带 body）。
 * 三个硬要求：
 *  1) 只依赖 `seq` 排序：乱序/重复到达时用重排缓冲按 seq 递增投递；
 *  2) 支持 abort：外部 signal 触发时立即停止读取并抛 ABORTED；
 *  3) 半包容错：按 `\n\n` 切帧，跨 chunk 的半个事件留在缓冲区等下一块。
 */
import { ApiError, parseErrorResponse } from './api';
import type { SseEvent, SseEventType } from '../app/types';

const EVENT_TYPES: ReadonlySet<string> = new Set<SseEventType>([
  'session',
  'step',
  'reasoning_delta',
  'assistant_delta',
  'tool_call',
  'tool_result',
  'artifact',
  'approval_required',
  'usage',
  'error',
  'done',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * 把一行 `data:` 的 JSON 解析成 SseEvent。
 * 不认识的事件/类型返回 null（向前兼容：后端加新事件不会打挂前端）。
 */
export function parseSseEvent(raw: string): SseEvent | null {
  if (raw === '' || raw === '[DONE]' || raw === 'keepalive') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  const type = value.type;
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return null;
  if (type === 'done' && typeof value.finish_reason !== 'string') {
    // 兜底：done 允许缺 finish_reason，前端按完成处理
    value.finish_reason = 'stop';
  }

  const seqRaw = value.seq;
  const seq = typeof seqRaw === 'number' && Number.isFinite(seqRaw) ? seqRaw : 0;

  return { ...(value as unknown as SseEvent), seq, type: type as SseEventType };
}

export interface StreamSseOptions {
  /** 相对路径（推荐，走 /api 前缀）或绝对 URL */
  path: string;
  body?: unknown;
  method?: 'POST' | 'GET';
  signal?: AbortSignal;
  onEvent: (event: SseEvent) => void;
  /** 连接建立（收到响应头、非 4xx/5xx） */
  onOpen?: () => void;
  /** 正常结束（收到 done 或服务端关闭流） */
  onClose?: () => void;
  /** 无法解析的原始帧（仅诊断用，不打断流） */
  onRawError?: (raw: string, reason: string) => void;
  headers?: Record<string, string>;
}

/** 重排缓冲上限：超过则强制按序 flush，避免后端 seq 跳号造成永久等待 */
const MAX_BUFFERED = 256;

/**
 * 发起一次 SSE 请求并消费到流结束。
 * 正常流结束不抛错；HTTP 错误 / 网络错误 / abort 会抛 ApiError。
 */
export async function streamSse(options: StreamSseOptions): Promise<void> {
  const { path, body, method = 'POST', signal, onEvent, onOpen, onClose, onRawError } = options;
  const url = path.startsWith('http') ? path : `${path.startsWith('/api') ? '' : '/api'}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        accept: 'text/event-stream',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw new ApiError('ABORTED', '已停止生成', 0);
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ApiError(
      'NETWORK_ERROR',
      `无法建立流式连接（${url}）：${detail}。请确认后端已在 3200 端口启动。`,
      0,
    );
  }

  if (!res.ok) throw await parseErrorResponse(res, url);

  onOpen?.();

  if (!res.body) {
    throw new ApiError('INTERNAL', '当前浏览器不支持流式响应（ReadableStream 不可用）', 0);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let lastSeq = 0;
  const pending = new Map<number, SseEvent>();

  const emit = (event: SseEvent): void => {
    onEvent(event);
    if (event.seq > lastSeq) lastSeq = event.seq;
  };

  /** 按 seq 连续投递（缺口未到时先缓冲） */
  const flushInOrder = (): void => {
    for (;;) {
      const next = pending.get(lastSeq + 1);
      if (!next) break;
      pending.delete(lastSeq + 1);
      emit(next);
    }
  };

  /** 缺口长期存在时强制放行剩余事件，宁可乱序也不能让 UI 卡死 */
  const flushForced = (): void => {
    const keys = [...pending.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      const event = pending.get(key);
      pending.delete(key);
      if (event) emit(event);
    }
  };

  const dispatchFrame = (frame: string): void => {
    // 一帧可能含多行（data: 可多次、: 注释、event: / id: 忽略）
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
        continue;
      }
      // event: / id: / retry: 不需要（类型在 JSON 里）
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    const event = parseSseEvent(raw);
    if (!event) {
      onRawError?.(raw, '无法解析为已知 SSE 事件');
      return;
    }
    if (event.seq <= 0) {
      // 无 seq 的旧式事件：直接投递
      onEvent(event);
      return;
    }
    if (event.seq <= lastSeq) return; // 重复帧，丢弃
    pending.set(event.seq, event);
    flushInOrder();
    if (pending.size > MAX_BUFFERED) flushForced();
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf('\n\n');
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        dispatchFrame(frame);
        idx = buffer.indexOf('\n\n');
      }
    }
    // 流结束时把尾部残帧与未投递事件放行
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail !== '') dispatchFrame(tail);
    flushForced();
    onClose?.();
  } catch (cause) {
    if (signal?.aborted) throw new ApiError('ABORTED', '已停止生成', 0);
    if (cause instanceof ApiError) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ApiError('NETWORK_ERROR', `流式连接中断：${detail}`, 0);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 已被取消时 releaseLock 会抛；忽略
    }
  }
}
