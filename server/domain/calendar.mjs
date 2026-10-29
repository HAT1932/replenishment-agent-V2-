/**
 * calendar.mjs — 到货窗口综合系数（修 v1 的 D3）
 * ---------------------------------------------------------------------------
 * 文档口径（22065 + 截图 03）：
 *   综合系数 = Σ(窗口内每日系数) / 窗口天数
 *   工作日 = 1；双休日、重大节假日可分别配置系数；同一天命中多个系数，取其中较大者。
 *   官方算例：12/5 到货、周期 5 天（覆盖 12/5–12/9），2 天双休日 1.1、1 天节假日 1.2 且重叠
 *            → (1+1+1+1.1+1.2)/5 = 1.06
 *
 * 修 v1 的 bug：v1 用 `Math.max(1, ...)` 当每日候选，导致 <1 的系数被静默吞掉
 * （配双休日 0.8 时综合系数恒为 1）。正确做法：**候选只在"命中的系数"之间取 max**，
 * 都没命中才取 1。这样 0.1–5 的配置区间才自洽（周末销量更低是真实业务场景）。
 *
 * 窗口语义：`[arrivalDate, arrivalDate + cycleDays - 1]`（闭区间，见假设 H3）。
 */
import { addDays, assertDate, isWeekend, weekdayIndex, WEEKDAY_LABEL } from './dates.mjs';
import { validationError } from './errors.mjs';
import { roundTo } from './math.mjs';

function normalizeSet(holidays) {
  if (holidays instanceof Set) return holidays;
  if (Array.isArray(holidays)) return new Set(holidays.map((h) => String(h).slice(0, 10)));
  if (holidays && typeof holidays === 'object') return new Set(Object.keys(holidays));
  return new Set();
}

function normalizeCoef({ enabled, coefficient, fallback }) {
  if (!Number(enabled)) return { enabled: false, coefficient: fallback };
  const n = Number(coefficient);
  if (!Number.isFinite(n) || n <= 0) {
    throw validationError(`系数必须为正数，收到 ${JSON.stringify(coefficient)}`);
  }
  if (n < 0.1 || n > 5) {
    throw validationError(`系数需在 0.1–5 之间，收到 ${n}`);
  }
  return { enabled: true, coefficient: n };
}

/**
 * @param {{
 *   arrivalDate: string, cycleDays: number,
 *   weekend?: {enabled?: any, coefficient?: number} | boolean, weekendCoefficient?: number,
 *   holiday?: {enabled?: any, coefficient?: number} | boolean, holidayCoefficient?: number,
 *   holidays?: string[] | Set<string>,
 *   weekendEnabled?: any, holidayEnabled?: any
 * }} input
 * @returns {{coefficient_exact:number, coefficient:number, days:number, total_exact:number,
 *   window:{start:string,end:string}, series:Array<{date:string,weekday:number,weekday_label:string,
 *   factor:number,reasons:string[]}>, assumptions:string[]}}
 */
export function coverageCoefficient(input = {}) {
  const arrivalDate = input.arrivalDate;
  assertDate(arrivalDate, 'arrivalDate');

  const cycleDays = Number(input.cycleDays);
  if (!Number.isFinite(cycleDays) || cycleDays < 1) {
    throw validationError(`cycleDays 必须 ≥1，收到 ${JSON.stringify(input.cycleDays)}`);
  }
  if (Math.abs(cycleDays - Math.round(cycleDays)) > 1e-9) {
    throw validationError(`cycleDays 必须为整数天，收到 ${cycleDays}（避免 v1 "公式 7.5 天 / 窗口 8 天" 的口径错位）`);
  }
  const days = Math.round(cycleDays);

  const weekendEnabled =
    input.weekend?.enabled !== undefined ? input.weekend.enabled : input.weekendEnabled;
  const weekendCoef =
    input.weekend?.coefficient !== undefined ? input.weekend.coefficient : input.weekendCoefficient;
  const holidayEnabled =
    input.holiday?.enabled !== undefined ? input.holiday.enabled : input.holidayEnabled;
  const holidayCoef =
    input.holiday?.coefficient !== undefined ? input.holiday.coefficient : input.holidayCoefficient;

  const weekend = normalizeCoef({ enabled: weekendEnabled, coefficient: weekendCoef, fallback: 1.1 });
  const holiday = normalizeCoef({ enabled: holidayEnabled, coefficient: holidayCoef, fallback: 1.2 });
  const holidaySet = normalizeSet(input.holidays);

  const series = [];
  let total = 0;
  for (let i = 0; i < days; i++) {
    const date = addDays(arrivalDate, i);
    const wd = weekdayIndex(date);
    /** @type {number[]} 只收集"命中的系数"，不再把 1 混进候选 */
    const hits = [];
    const reasons = [];
    if (weekend.enabled && isWeekend(date)) {
      hits.push(weekend.coefficient);
      reasons.push(`双休日×${weekend.coefficient}`);
    }
    if (holiday.enabled && holidaySet.has(date)) {
      hits.push(holiday.coefficient);
      reasons.push(`节假日×${holiday.coefficient}`);
    }
    const factor = hits.length ? Math.max(...hits) : 1;
    if (!hits.length) reasons.push('工作日×1');
    total += factor;
    series.push({
      date,
      weekday: wd,
      weekday_label: WEEKDAY_LABEL[wd],
      factor: roundTo(factor, 6),
      reasons,
    });
  }

  const coefficientExact = total / days;
  return {
    coefficient_exact: coefficientExact,
    coefficient: roundTo(coefficientExact, 6),
    days,
    total_exact: total,
    window: { start: arrivalDate, end: addDays(arrivalDate, days - 1) },
    series,
    assumptions: ['H3'],
  };
}
