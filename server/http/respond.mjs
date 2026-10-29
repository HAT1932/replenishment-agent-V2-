/**
 * respond.mjs — 统一响应信封 / 错误映射 / 安全响应头
 * ---------------------------------------------------------------------------
 * 契约（docs/contracts.md §6）：
 *   成功 → `{ ok: true, data }`
 *   失败 → HTTP 4xx/5xx + `{ ok: false, error: { code, message, details? } }`
 *
 * 错误码只有 8 个（不新增契约外 code）：
 *   VALIDATION_ERROR(400) / NOT_FOUND(404) / APPROVAL_REQUIRED(409) / CONFLICT(409)
 *   DATA_MISSING(422) / STALE_DATA(422) / UPSTREAM_LLM_ERROR(502) / INTERNAL(500)
 *
 * 唯一显式例外：请求体超过 2MB 时用 HTTP 413（语义正确），code 仍为 VALIDATION_ERROR。
 *
 * 安全纪律：
 *  - 永不回显 API key / Authorization / 堆栈（只回脱敏后的 message + 可选 reason）；
 *  - 全部响应带 nosniff 等基线头；`/api/*` 一律 `Cache-Control: no-store`。
 */

/** 错误码 → HTTP 状态码（契约 §6，逐条对应） */
export const STATUS_BY_CODE = Object.freeze({
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  APPROVAL_REQUIRED: 409,
  CONFLICT: 409,
  DATA_MISSING: 422,
  STALE_DATA: 422,
  UPSTREAM_LLM_ERROR: 502,
  INTERNAL: 500,
});

export const KNOWN_CODES = Object.freeze(new Set(Object.keys(STATUS_BY_CODE)));

/** 契约内错误码（供域层/工具层复制使用，避免各层各写一份） */
export const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  CONFLICT: 'CONFLICT',
  DATA_MISSING: 'DATA_MISSING',
  STALE_DATA: 'STALE_DATA',
  UPSTREAM_LLM_ERROR: 'UPSTREAM_LLM_ERROR',
  INTERNAL: 'INTERNAL',
});

/** 统一的 API 错误类型：router/handler 只抛它或域层 DomainError */
export class ApiError extends Error {
  /**
   * @param {string} code 契约错误码
   * @param {string} message 面向人的中文说明（会回给前端，禁止放密钥/堆栈）
   * @param {{ details?: unknown, status?: number, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(String(message ?? '未知错误'));
    this.name = 'ApiError';
    this.code = KNOWN_CODES.has(code) ? code : 'INTERNAL';
    this.status = Number.isInteger(options.status)
      ? options.status
      : STATUS_BY_CODE[this.code] ?? 500;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export const validationError = (message, details) =>
  new ApiError('VALIDATION_ERROR', message, { details });
export const notFound = (message, details) => new ApiError('NOT_FOUND', message, { details });
export const conflict = (message, details) => new ApiError('CONFLICT', message, { details });
export const approvalRequired = (message, details) =>
  new ApiError('APPROVAL_REQUIRED', message, { details });
export const dataMissing = (message, details) => new ApiError('DATA_MISSING', message, { details });
export const staleData = (message, details) => new ApiError('STALE_DATA', message, { details });
export const upstreamError = (message, details) =>
  new ApiError('UPSTREAM_LLM_ERROR', message, { details });
export const internalError = (message, details) => new ApiError('INTERNAL', message, { details });
/** 请求体过大：413 + VALIDATION_ERROR（唯一显式状态覆盖，见文件头） */
export const payloadTooLarge = (limitBytes) =>
  new ApiError('VALIDATION_ERROR', `请求体过大（上限 ${limitBytes} 字节）`, {
    status: 413,
    details: { limit_bytes: limitBytes, reason: 'PAYLOAD_TOO_LARGE' },
  });

/** 依赖未就绪（并行开发期：对方模块还没落地）→ 明确 INTERNAL 提示，而不是崩进程 */
export const dependencyMissing = (what) =>
  internalError(`依赖未就绪：${what} 尚未提供`, { reason: 'DEPENDENCY_MISSING', dependency: what });

/** 请求体上限：2MB（硬性要求） */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  // OpenAI/DeepSeek 风格 key
  [/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***'],
  // api_key=xxx / apiKey: xxx / "api_key": "xxx"
  [/\b(api[_-]?key\b\s*["']?\s*[:=]\s*["']?)([^\s"',;}]+)/gi, '$1***'],
  // Authorization: Bearer xxx
  [/\b(authorization\b\s*["']?\s*[:=]\s*["']?)(bearer\s+)?([^\s"',;}]+)/gi, '$1***'],
  // LLM_API_KEY=xxx（.env 行）
  [/\b(LLM_API_KEY\s*=\s*)([^\s"']+)/g, '$1***'],
  // Bearer xxx 裸露
  [/\b(bearer\s+)([A-Za-z0-9._\-]{16,})/gi, '$1***'],
];

/**
 * 把文本里的密钥类内容打码。日志与错误详情共用同一份规则。
 * @param {unknown} value
 * @returns {string}
 */
export function redact(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/** 截断过长文本（避免把超长请求体回显给前端） */
export function truncate(text, max = 200) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…（已截断 ${s.length - max} 字）`;
}

/** 安全日志：只允许 method/path/status/耗时；header 一律不透出 */
export function logAccess({ method, pathname, status, durationMs, note }) {
  const line = `[api] ${method} ${pathname} ${status} ${Math.round(durationMs)}ms${note ? ` ${note}` : ''}`;
  // eslint-disable-next-line no-console
  console.log(redact(line));
}

// ---------------------------------------------------------------------------
// 错误归一化
// ---------------------------------------------------------------------------

/**
 * 把任意错误投影成 `{ code, message, details, status }`。
 * 顺序：ApiError → 带契约 code 的域/工具错误（DomainError 等）→ INTERNAL。
 * @param {unknown} err
 * @returns {{ code: string, message: string, details?: unknown, status: number }}
 */
export function normalizeError(err) {
  if (err instanceof ApiError) {
    return {
      code: err.code,
      message: redact(err.message),
      ...(err.details !== undefined ? { details: err.details } : {}),
      status: err.status,
    };
  }

  const code = typeof err?.code === 'string' ? err.code : null;
  if (code && KNOWN_CODES.has(code)) {
    // 域层 DomainError / 工具层错误信封里已带契约 code，直接沿用（含 details）。
    // status 允许显式覆盖（用于 413 这类契约外的 HTTP 语义），但必须落在 4xx/5xx 区间。
    const explicitStatus =
      Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 ? err.status : null;
    return {
      code,
      message: redact(err?.message ?? '请求失败'),
      ...(err?.details !== undefined ? { details: err.details } : {}),
      status: explicitStatus ?? STATUS_BY_CODE[code],
    };
  }

  // 未知错误：对外只给通用文案 + 脱敏后的一句原因；堆栈只进服务端日志
  const reason = redact(err?.message ?? String(err ?? 'unknown'));
  return {
    code: 'INTERNAL',
    message: '服务器内部错误',
    details: { reason: truncate(reason, 500) },
    status: 500,
  };
}

// ---------------------------------------------------------------------------
// 响应头
// ---------------------------------------------------------------------------

/**
 * 安全基线响应头。
 * @param {import('node:http').ServerResponse} res
 * @param {{ api?: boolean }} [options] api=true 时附带 no-store 与 API 专用 CSP
 */
export function applyCommonHeaders(res, { api = false } = {}) {
  if (res.headersSent) return;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // 不设 Access-Control-Allow-*：本服务只服务同源前端，无需 CORS。
  if (api) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
}

/** HTML 页面用 CSP（Vite 产物 + React 内联样式需要 style-src 'unsafe-inline'） */
export const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------

/**
 * 发送 JSON 响应（自动 Content-Length + no-store）。发送后不再可写。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string>} [extraHeaders]
 */
export function sendJson(res, status, payload, extraHeaders) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'no-store');
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  }
  res.end(body);
}

/**
 * 成功信封 `{ ok: true, data }`（data 为 undefined 时省略该字段）。
 */
export function sendOk(res, data, { status = 200, headers } = {}) {
  const payload = data === undefined ? { ok: true } : { ok: true, data };
  sendJson(res, status, payload, headers);
}

/**
 * 失败信封 `{ ok:false, error:{ code, message, details? } }`。
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} err
 */
export function sendError(res, err) {
  const normalized = normalizeError(err);
  const error = { code: normalized.code, message: normalized.message };
  if (normalized.details !== undefined) error.details = normalized.details;
  sendJson(res, normalized.status, { ok: false, error });
  return normalized;
}

/** 纯文本响应（静态服务未构建等非 API 场景） */
export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders) {
  if (res.writableEnded) return;
  const body = Buffer.from(String(text), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(body.length));
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  }
  res.end(body);
}

export default {
  STATUS_BY_CODE,
  KNOWN_CODES,
  ERROR_CODES,
  MAX_BODY_BYTES,
  ApiError,
  applyCommonHeaders,
  HTML_CSP,
  logAccess,
  normalizeError,
  payloadTooLarge,
  redact,
  sendError,
  sendJson,
  sendOk,
  sendText,
  truncate,
};
