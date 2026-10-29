/**
 * format.ts — 展示层格式化（**只格式化，不计算业务数字**）
 *
 * 纪律：任何业务数值（建议数量、日均销量、系数、KPI、金额）都来自服务端，
 * 本模块只负责「把服务端给的数变成字符串」，不做聚合、不做推算、不做单位换算。
 */

/** 空值统一占位符（中文字体下比 "-" 更清晰，且不参与 tabular-nums 对齐） */
export const DASH = '—';

/** 运行时数值守卫：服务端 `unknown` 字段的窄化入口 */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 把 unknown 收窄为 number | null（字符串数字也接受，服务端偶有 string 化输出） */
export function toNumber(v: unknown): number | null {
  if (isFiniteNumber(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 整数千分位；null/undefined/NaN → 占位符 */
export function fmtInt(value: unknown, dash: string = DASH): string {
  const n = toNumber(value);
  if (n === null) return dash;
  return Math.round(n).toLocaleString('zh-CN');
}

/** 固定小数位（默认 1）；不做四舍五入以外的加工 */
export function fmtDec(value: unknown, digits = 1, dash: string = DASH): string {
  const n = toNumber(value);
  if (n === null) return dash;
  return n.toFixed(digits);
}

/** 金额：¥ + 千分位 + 2 位小数（契约 §9：单位=元） */
export function fmtMoney(value: unknown, digits = 2, dash: string = DASH): string {
  const n = toNumber(value);
  if (n === null) return dash;
  return `¥${n.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/** 比率（0.1234 → 12.3%）；服务端若已给百分数请直接用 fmtDec */
export function fmtPct(value: unknown, digits = 1, dash: string = DASH): string {
  const n = toNumber(value);
  if (n === null) return dash;
  return `${(n * 100).toFixed(digits)}%`;
}

/** 日期：只取 YYYY-MM-DD 部分 */
export function fmtDate(value: unknown, dash: string = DASH): string {
  if (typeof value !== 'string' || value === '') return dash;
  return value.slice(0, 10);
}

/** 日期时间：取 YYYY-MM-DD HH:MM */
export function fmtDateTime(value: unknown, dash: string = DASH): string {
  if (typeof value !== 'string' || value === '') return dash;
  const s = value.replace('T', ' ');
  return s.length >= 16 ? s.slice(0, 16) : s.slice(0, 10);
}

/** 时间：HH:MM:SS（审计时间线用） */
export function fmtTime(value: unknown, dash: string = DASH): string {
  if (typeof value !== 'string' || value === '') return dash;
  const m = /(\d{2}:\d{2}:\d{2})/.exec(value);
  if (m) return m[1] ?? dash;
  return fmtDateTime(value, dash);
}

/** 毫秒耗时：<1000ms 显示整数 ms，否则显示秒（1 位小数） */
export function fmtDuration(ms: unknown): string {
  const n = toNumber(ms);
  if (n === null) return DASH;
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}

/** 带符号的整数（Δ 徽标用；正数显式 +，负数保留 Unicode 减号 −） */
export function fmtSigned(value: unknown): string {
  const n = toNumber(value);
  if (n === null) return DASH;
  const rounded = Math.round(n);
  if (rounded > 0) return `+${rounded}`;
  if (rounded < 0) return `−${Math.abs(rounded)}`;
  return '0';
}

/** 文本截断（长 JSON / 长摘要） */
export function truncate(text: string, max = 160): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** 任意值 → 可展示的紧凑 JSON 文本（用于展开原始工具结果） */
export function prettyJson(value: unknown, indent = 2): string {
  try {
    return JSON.stringify(value, null, indent) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 单行摘要：对象取 key 数，数组取长度，避免把整坨 JSON 塞进时间线卡片 */
export function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) return DASH;
  if (Array.isArray(value)) return `数组(${value.length})`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 0 ? '空对象' : `对象(${keys.length} 字段)`;
  }
  if (typeof value === 'string') return truncate(value, 90);
  return String(value);
}

/** 星期中文（指数 0=周日，与 domain.weekdayIndex 对齐） */
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

export function weekdayLabel(index: number): string {
  return WEEKDAY_CN[((index % 7) + 7) % 7] ?? DASH;
}
