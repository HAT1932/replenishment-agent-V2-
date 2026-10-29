/**
 * util.mjs — 工具层公共小工具（信封、校验、截断、错误）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 *
 * 约定：
 *  - 工具实现只 `return data`（成功）或 `throw toolError(...)`（失败）；
 *  - 统一信封与 meta 由 registry 组装，避免每个工具重复；
 *  - 审计 payload 必须截断到 2KB（contracts §5 / 任务书 §3.4）。
 */

import { Buffer } from 'node:buffer';

/** 审计 payload 上限（字节） */
export const AUDIT_PAYLOAD_LIMIT = 2048;

/** 允许对外暴露的错误码（contracts §6），工具层只使用这些 */
export const ERROR_CODES = Object.freeze([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'DATA_MISSING',
  'STALE_DATA',
  'APPROVAL_REQUIRED',
  'CONFLICT',
  'UPSTREAM_LLM_ERROR',
  'INTERNAL',
  // 运行时内部（预算/超时）扩展码，前端按字符串展示即可
  'TOOL_TIMEOUT',
  'TOOL_CALL_BUDGET_EXCEEDED',
  'MAX_STEPS_EXCEEDED',
  'TURN_BUDGET_EXCEEDED',
]);

/** 工具层错误：带契约错误码，registry 会映射成 { ok:false, error } */
export class ToolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{hint?: string, details?: unknown, cause?: unknown}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = ERROR_CODES.includes(code) ? code : 'INTERNAL';
    if (extra.hint) this.hint = extra.hint;
    if (extra.details !== undefined) this.details = extra.details;
    if (extra.cause) this.cause = extra.cause;
  }
}

/** 抛出工具错误（语法糖，便于工具实现里早退） */
export function toolError(code, message, extra) {
  throw new ToolError(code, message, extra);
}

/** 成功返回（仅当工具需要显式构造信封时使用；默认直接 return data） */
export function ok(data, meta = {}) {
  return { ok: true, data, meta };
}

/** 失败返回（仅当工具需要「不抛异常」地表达失败时使用） */
export function fail(code, message, hint) {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
}

/**
 * 将任意值序列化为受字节上限约束的审计 payload。
 * @param {unknown} value
 * @param {number} [limit]
 * @returns {{ value?: unknown, preview?: string, truncated: boolean, bytes: number }}
 */
export function truncateForAudit(value, limit = AUDIT_PAYLOAD_LIMIT) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = 'null';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= limit) return { value, truncated: false, bytes };
  // 按字符切分后再校验字节数，避免把中文截半
  let preview = text.slice(0, limit);
  while (Buffer.byteLength(preview, 'utf8') > limit) preview = preview.slice(0, -1);
  return { preview, truncated: true, bytes };
}

/** 事件里下发的 data 也做上限保护（SSE 不宜过大）；返回 {data, truncated} */
export function truncateForEvent(value, limit = 8192) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = 'null';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= limit) return { data: value, truncated: false, bytes };
  return {
    data: { truncated: true, bytes, preview: text.slice(0, limit) },
    truncated: true,
    bytes,
  };
}

// ---------------------------------------------------------------------------
// 轻量 JSON Schema 校验（只覆盖本项目的工具参数形状：object + 基本类型）
// 目的不是通用校验器，而是挡住模型乱传参导致的下游崩溃。
// ---------------------------------------------------------------------------

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

/**
 * 校验工具参数；不合法时抛 VALIDATION_ERROR。
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {object} schema
 */
export function validateArgs(toolName, args, schema) {
  if (schema?.type !== 'object') return;
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    toolError('VALIDATION_ERROR', `${toolName} 的参数必须是对象`);
  }
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) {
      toolError('VALIDATION_ERROR', `${toolName} 缺少必填参数：${key}`, {
        hint: `必填参数：${(schema.required ?? []).join(', ')}`,
      });
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const rule = props[key];
    if (!rule) {
      // 契约参数是冻结的：多余参数直接拒绝，避免模型「自创参数」被静默忽略
      toolError('VALIDATION_ERROR', `${toolName} 不支持参数：${key}`, {
        hint: `允许的参数：${Object.keys(props).join(', ') || '无'}`,
      });
    }
    const checkList = Array.isArray(rule.type)
      ? rule.type.map((t) => TYPE_CHECKS[t]).filter(Boolean)
      : [TYPE_CHECKS[rule.type]].filter(Boolean);
    if (checkList.length && !checkList.some((fn) => fn(value))) {
      toolError('VALIDATION_ERROR', `${toolName} 参数 ${key} 类型应为 ${[].concat(rule.type).join('|')}`);
    }
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
      toolError('VALIDATION_ERROR', `${toolName} 参数 ${key} 取值必须是 ${rule.enum.join('|')}`);
    }
    if (typeof value === 'number') {
      if (rule.minimum !== undefined && value < rule.minimum) {
        toolError('VALIDATION_ERROR', `${toolName} 参数 ${key} 不能小于 ${rule.minimum}`);
      }
      if (rule.maximum !== undefined && value > rule.maximum) {
        toolError('VALIDATION_ERROR', `${toolName} 参数 ${key} 不能大于 ${rule.maximum}`);
      }
    }
    if (Array.isArray(value) && rule.items?.type) {
      const itemChecks = [].concat(rule.items.type).map((t) => TYPE_CHECKS[t]).filter(Boolean);
      if (itemChecks.length && value.some((v) => !itemChecks.some((fn) => fn(v)))) {
        toolError('VALIDATION_ERROR', `${toolName} 参数 ${key} 的元素类型应为 ${[].concat(rule.items.type).join('|')}`);
      }
    }
  }
}

/** 取业务日期：优先数据层 meta.today，其次按 UTC+8 用注入时钟推导 */
export async function resolveToday(ctx, explicit) {
  if (explicit) return explicit;
  try {
    if (ctx?.deps?.repository?.getMeta) {
      const meta = await ctx.deps.repository.getMeta(ctx.db);
      if (meta?.today) return String(meta.today);
    }
  } catch {
    /* 降级到时钟推导 */
  }
  return todayFromClock(ctx?.clock);
}

/** 用注入时钟推导 UTC+8 的 YYYY-MM-DD（运行时/工具不读系统时钟以外的来源） */
export function todayFromClock(clock) {
  const now = typeof clock === 'function' ? clock() : Date.now();
  const shanghai = new Date(new Date(now).getTime() + 8 * 3600 * 1000);
  return shanghai.toISOString().slice(0, 10);
}

/** 从 SKU 主数据里取 id（contract 里字段名是 sku_id；容忍 id 别名便于联调） */
export function skuIdOf(sku) {
  return sku?.sku_id ?? sku?.id ?? sku?.sku_code;
}

/** 数字参数默认值 + 夹取 */
export function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}
