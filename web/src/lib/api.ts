/**
 * api.ts — HTTP 客户端（统一信封解析 / 错误归一 / 查询串）
 *
 * 契约 §6：成功 `{ok:true,data}`；失败 4xx/5xx + `{ok:false,error:{code,message,details?}}`。
 * 本模块把「网络失败 / 非 JSON / 业务错误」统一成 ApiError，页面只需渲染 message。
 */
import type { ApiErrorBody, ErrorCode } from '../app/types';

export const API_BASE = '/api';

/** 归一化后的前端错误对象（不依赖 class 也能判型，见 isApiError） */
export interface ApiErrorShape {
  name: 'ApiError';
  code: ErrorCode | string;
  message: string;
  status: number;
  details?: unknown;
  hint?: string;
}

export class ApiError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;
  readonly details?: unknown;
  readonly hint?: string;

  constructor(code: ErrorCode | string, message: string, status = 0, details?: unknown, hint?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.hint = hint;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** 任意异常 → 面向用户的中文文案（catch (e: unknown) 的唯一出口） */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) {
    if (e.name === 'AbortError') return '请求已中止';
    return e.message || '未知错误';
  }
  if (typeof e === 'string') return e;
  return '未知错误';
}

/** 从 error 中取错误码，用于针对性提示（如 APPROVAL_REQUIRED） */
export function errorCode(e: unknown): string | null {
  if (isApiError(e)) return e.code;
  return null;
}

/** 网络层失败的可读文案（后端未启动是最常见场景） */
function networkMessage(path: string, cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return `无法连接后端（${API_BASE}${path}）：${raw}。请确认后端已在 3200 端口启动（npm run dev），或 vite 代理正常。`;
}

const HTTP_CODE_MAP: Record<number, ErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'APPROVAL_REQUIRED',
  403: 'APPROVAL_REQUIRED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  500: 'INTERNAL',
  502: 'UPSTREAM_LLM_ERROR',
  503: 'UPSTREAM_LLM_ERROR',
};

export type QueryValue = string | number | boolean | null | undefined;

/** 查询串：跳过 undefined/null/''，数组用重复 key，全空返回 '' */
export function queryString(params?: Record<string, QueryValue | QueryValue[]>): string {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v === undefined || v === null || v === '') continue;
        usp.append(key, String(v));
      }
      continue;
    }
    usp.append(key, String(value));
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

/** 把后端错误体解析成 ApiError（供 request 与 SSE 共用） */
export async function parseErrorResponse(res: Response, path: string): Promise<ApiError> {
  let body: unknown = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  const envelopeError =
    body && typeof body === 'object' && 'error' in body
      ? (body as { error?: Partial<ApiErrorBody> }).error
      : undefined;

  if (envelopeError && typeof envelopeError.message === 'string') {
    return new ApiError(
      envelopeError.code ?? HTTP_CODE_MAP[res.status] ?? 'INTERNAL',
      envelopeError.message,
      res.status,
      envelopeError.details,
      envelopeError.hint,
    );
  }

  const fallbackCode = HTTP_CODE_MAP[res.status] ?? (res.status >= 500 ? 'INTERNAL' : 'VALIDATION_ERROR');
  const snippet = text ? `：${text.slice(0, 180)}` : '';
  return new ApiError(fallbackCode, `请求失败（HTTP ${res.status} ${path}）${snippet}`, res.status);
}

export interface RequestOptions {
  query?: Record<string, QueryValue | QueryValue[]>;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** 超时（毫秒）；到点主动 abort，避免页面永久转圈 */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** 核心请求：返回信封里的 `data`，失败一律抛 ApiError */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { query, method = 'GET', body, signal, timeoutMs = 30_000, headers } = options;
  const url = `${API_BASE}${path}${queryString(query)}`;

  const controller = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    if (timedOut) {
      throw new ApiError('NETWORK_ERROR', `请求超时（${Math.round(timeoutMs / 1000)}s）：${path}`, 0);
    }
    if (controller.signal.aborted) {
      throw new ApiError('ABORTED', '请求已中止', 0);
    }
    throw new ApiError('NETWORK_ERROR', networkMessage(path, cause), 0);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }

  if (!res.ok) throw await parseErrorResponse(res, path);

  // 204 / 空体：调用方按 T 自负其责（页面只读明确定义的字段）
  const text = await res.text();
  if (!text) return undefined as T;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError('INTERNAL', `后端返回了非 JSON 内容（${path}）`, res.status);
  }

  if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
    const envelope = parsed as { ok?: boolean; data?: T; error?: ApiErrorBody };
    if (envelope.ok === false) {
      const err = envelope.error;
      throw new ApiError(
        err?.code ?? 'INTERNAL',
        err?.message ?? `请求失败（${path}）`,
        res.status,
        err?.details,
        err?.hint,
      );
    }
    return envelope.data as T;
  }

  // 容忍未套信封的实现（只在前端自证无害时使用）
  return parsed as T;
}

export function apiGet<T>(
  path: string,
  query?: Record<string, QueryValue | QueryValue[]>,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>(path, { query, signal });
}

export function apiPost<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'POST', body, signal, timeoutMs: 120_000 });
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body });
}

export function apiDelete<T>(path: string, query?: Record<string, QueryValue | QueryValue[]>): Promise<T> {
  return request<T>(path, { method: 'DELETE', query });
}

/**
 * 探测可选接口是否已实现（契约 §7：CSV 导出「若已实现则接，否则隐藏按钮」）。
 * 404 → 视为未实现；其余状态（含 405/401）说明路由存在。
 */
export async function probeEndpoint(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: 'HEAD', headers: { accept: '*/*' } });
    if (res.status === 404) return false;
    return true;
  } catch {
    return false;
  }
}

/** 便捷：读取列表型返回（rows / items / drafts / orders 任一） */
export function pickList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  for (const key of ['rows', 'items', 'drafts', 'orders', 'sessions', 'events', 'plans', 'assumptions', 'schedules']) {
    const value = obj[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}
