/**
 * dates.mjs — 日期工具（全部 UTC，无时区漂移；严格校验真实日历日）
 * ---------------------------------------------------------------------------
 * 修 v1 的 D5：v1 用 `new Date(Date.UTC(...))` 直接接受 '2026-02-31' 并静默滚到 3 月。
 * 这里回读校验，非法日期直接抛 VALIDATION_ERROR。
 */
import { validationError } from './errors.mjs';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** @returns {{y:number,m:number,d:number}} */
export function parseDate(value, fieldName = 'date') {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw validationError(`${fieldName} 需为 YYYY-MM-DD 字符串，收到 ${JSON.stringify(value)}`);
  }
  const [, y, m, d] = DATE_RE.exec(value);
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    throw validationError(`${fieldName} 不是真实日历日：${value}（例：2026-02-31 不存在）`);
  }
  return { y: year, m: month, d: day };
}

export function isValidDate(value) {
  try {
    parseDate(value);
    return true;
  } catch {
    return false;
  }
}

export function assertDate(value, fieldName = 'date') {
  parseDate(value, fieldName);
  return value;
}

function toIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dateToMs(date) {
  const { y, m, d } = parseDate(date);
  return Date.UTC(y, m - 1, d);
}

/** 日期 + n 天 */
export function addDays(date, n) {
  const ms = dateToMs(date);
  const delta = Math.trunc(Number(n) || 0);
  return toIso(ms + delta * 86400000);
}

/** b - a（天） */
export function diffDays(a, b) {
  return Math.round((dateToMs(b) - dateToMs(a)) / 86400000);
}

/** 0=周日 … 6=周六 */
export function weekdayIndex(date) {
  return new Date(dateToMs(date)).getUTCDay();
}

/** 闭区间 [from, to] 的所有日期 */
export function eachDate(from, to) {
  const start = dateToMs(from);
  const end = dateToMs(to);
  if (end < start) return [];
  const out = [];
  for (let ms = start; ms <= end; ms += 86400000) out.push(toIso(ms));
  return out;
}

/** 相对 asOf 的「近 n 个自然日」窗口（含 asOf 当天，升序） */
export function lastNDates(asOf, n) {
  const days = Math.max(1, Math.trunc(Number(n) || 1));
  return eachDate(addDays(asOf, -(days - 1)), asOf);
}

export function isWeekend(date) {
  const wd = weekdayIndex(date);
  return wd === 0 || wd === 6;
}

export const WEEKDAY_LABEL = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);
