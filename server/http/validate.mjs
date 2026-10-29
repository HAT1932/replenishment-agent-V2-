/**
 * validate.mjs — 手写入参校验（零依赖）
 * ---------------------------------------------------------------------------
 * 为什么手写：服务端零第三方依赖，且契约 §6 的参数面很小。统一规则：
 *  - 校验失败一律抛 `ApiError('VALIDATION_ERROR')`，details 形如
 *    `{ fields: [{ field, message }] }`，便于前端按字段高亮；
 *  - 查询串里的数字/布尔用宽松解析（'3' → 3、'true' → true），
 *    请求体里则要求类型正确（宁可报错也不猜）；
 *  - 日期一律 `YYYY-MM-DD` 且必须是真实日历日（2026-02-31 → 失败）。
 */

import { validationError, truncate } from './respond.mjs';

/** `YYYY-MM-DD`（不含时分秒） */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 严格日历日校验（与 domain.isValidDate 同语义，但不依赖域层加载顺序）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidDateString(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
  );
}

/** 把 1970 之类的越界年份也挡掉（SQLite/JS Date 都能表示，但业务上无意义） */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** 字段级报错 */
function fail(field, message, value) {
  const detail = { field, message };
  if (value !== undefined) detail.received = truncate(safePreview(value), 80);
  throw validationError(`请求参数校验失败：${field} ${message}`, { fields: [detail] });
}

function safePreview(value) {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  return String(value);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 未提供（undefined / null / 空串） */
function isAbsent(value) {
  return value === undefined || value === null || value === '';
}

/** 必填检查；返回 true 表示「确实有值」 */
function requireOrThrow(value, field, required) {
  if (isAbsent(value)) {
    if (required) fail(field, '必填', value);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 基础断言
// ---------------------------------------------------------------------------

/**
 * 字符串。
 * @param {unknown} value
 * @param {string} field
 * @param {{ required?: boolean, min?: number, max?: number, pattern?: RegExp,
 *           trim?: boolean, allowEmpty?: boolean, default?: unknown }} [options]
 */
export function assertString(value, field, options = {}) {
  const { required = false, min = 0, max = 4096, pattern = null, trim = true } = options;
  if (!requireOrThrow(value, field, required)) return options.default;
  if (typeof value !== 'string') fail(field, '必须是字符串', value);
  const text = trim ? value.trim() : value;
  if (!text && !options.allowEmpty) fail(field, '不能为空字符串', value);
  if (text.length < min) fail(field, `长度不能少于 ${min}`, value);
  if (text.length > max) fail(field, `长度不能超过 ${max}`, value);
  if (pattern && !pattern.test(text)) fail(field, '格式不合法', value);
  return text;
}

/** 标识符（session_id / plan_id / draft_id / approval_id …） */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertId(value, field, options = {}) {
  return assertString(value, field, { ...options, pattern: ID_PATTERN });
}

/** 整数（查询串允许数字字符串） */
export function assertInt(value, field, options = {}) {
  const { required = false, min = -Infinity, max = Infinity } = options;
  if (!requireOrThrow(value, field, required)) return options.default;
  let num = value;
  if (typeof num === 'string') {
    const trimmed = num.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) fail(field, '必须是整数', value);
    num = Number(trimmed);
  }
  if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isInteger(num)) {
    fail(field, '必须是整数', value);
  }
  if (num < min) fail(field, `不能小于 ${min}`, value);
  if (num > max) fail(field, `不能大于 ${max}`, value);
  return num;
}

/** 数字（可小数） */
export function assertNumber(value, field, options = {}) {
  const { required = false, min = -Infinity, max = Infinity } = options;
  if (!requireOrThrow(value, field, required)) return options.default;
  let num = value;
  if (typeof num === 'string') {
    const trimmed = num.trim();
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) fail(field, '必须是数字', value);
    num = Number(trimmed);
  }
  if (typeof num !== 'number' || !Number.isFinite(num)) fail(field, '必须是数字', value);
  if (num < min) fail(field, `不能小于 ${min}`, value);
  if (num > max) fail(field, `不能大于 ${max}`, value);
  return num;
}

/** 布尔（查询串 'true'/'1' 可接受；请求体要求真布尔） */
export function assertBoolean(value, field, options = {}) {
  if (!requireOrThrow(value, field, options.required)) return options.default;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return Boolean(value);
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0') return false;
  }
  fail(field, "必须是布尔值（true/false）", value);
  return undefined;
}

/** 枚举 */
export function assertEnum(value, field, values, options = {}) {
  if (!requireOrThrow(value, field, options.required)) return options.default;
  const text = typeof value === 'string' ? value.trim() : value;
  if (!values.includes(text)) fail(field, `必须是 ${values.join(' | ')} 之一`, value);
  return text;
}

/** 日期 `YYYY-MM-DD`（真实日历日） */
export function assertDate(value, field, options = {}) {
  if (!requireOrThrow(value, field, options.required)) return options.default;
  if (typeof value !== 'string' || !isValidDateString(value)) {
    fail(field, '必须是合法日期 YYYY-MM-DD', value);
  }
  const year = Number(value.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) fail(field, `年份需在 ${MIN_YEAR}–${MAX_YEAR}`, value);
  return value;
}

/**
 * 数组。
 * @param {unknown} value
 * @param {string} field
 * @param {{ required?: boolean, min?: number, max?: number,
 *           item?: (item: unknown, index: number) => unknown, default?: unknown }} [options]
 */
export function assertArray(value, field, options = {}) {
  const { required = false, min = 0, max = 1000, item } = options;
  if (!requireOrThrow(value, field, required)) return options.default;
  if (!Array.isArray(value)) fail(field, '必须是数组', value);
  if (value.length < min) fail(field, `至少需要 ${min} 项`, value);
  if (value.length > max) fail(field, `最多 ${max} 项`, value);
  if (typeof item === 'function') {
    return value.map((entry, index) => item(entry, index));
  }
  return value;
}

/** 对象（排除数组与 null） */
export function assertObject(value, field, options = {}) {
  if (!requireOrThrow(value, field, options.required)) return options.default;
  if (!isPlainObject(value)) fail(field, '必须是 JSON 对象', value);
  return value;
}

// ---------------------------------------------------------------------------
// 复合快捷断言
// ---------------------------------------------------------------------------

/** 分页：page ≥1、page_size 1..200 */
export function assertPagination(query) {
  const page = assertInt(query.get('page'), 'page', { required: false, min: 1, max: 1_000_000 }) ?? 1;
  const pageSize =
    assertInt(query.get('page_size'), 'page_size', { required: false, min: 1, max: 200 }) ?? 50;
  return { page, page_size: pageSize };
}

/** limit：默认 100，上限 500 */
export function assertLimit(value, field = 'limit', { default: dflt = 100, max = 500 } = {}) {
  return assertInt(value, field, { required: false, min: 1, max }) ?? dflt;
}

/** 会话消息内容 */
export function assertMessageContent(value) {
  return assertString(value, 'content', { required: true, min: 1, max: 8000 });
}

/** 审批决策 */
export const DECISIONS = Object.freeze(['approve', 'reject']);
export function assertDecision(value) {
  return assertEnum(value, 'decision', DECISIONS, { required: true });
}

/** 会话标题 */
export function assertTitle(value) {
  return assertString(value, 'title', { required: false, min: 1, max: 120, default: undefined });
}

/**
 * 请求体 JSON 解析（空体 → {}）。
 * 调用方负责先做 2MB 上限判断。
 * @param {string} raw
 * @returns {Record<string, unknown>}
 */
export function parseJsonBody(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw validationError('请求体不是合法 JSON', { fields: [{ field: 'body', message: 'JSON 解析失败' }] });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw validationError('请求体必须是 JSON 对象', {
      fields: [{ field: 'body', message: '必须是 JSON 对象' }],
    });
  }
  return parsed;
}

export default {
  assertArray,
  assertBoolean,
  assertDate,
  assertDecision,
  assertEnum,
  assertId,
  assertInt,
  assertLimit,
  assertMessageContent,
  assertNumber,
  assertObject,
  assertPagination,
  assertString,
  assertTitle,
  isValidDateString,
  parseJsonBody,
};
