/**
 * risk.mjs — 决策支持：可售天数 / 断货日 / 风险分级（**本实现增强，非有赞口径**）
 * ---------------------------------------------------------------------------
 * 为什么单列一个文件：这三件事是"辅助决策"的骨架，但**没有任何官方文档依据**。
 * 因此：
 *   1) 纯函数、无 IO、`asOf` 显式传入（与内核同纪律）；
 *   2) 输出附带 `provenance: 'enhancement'` 与假设 H10，UI 必须视觉区分；
 *   3) 阈值全部参数化，便于不同业态调整（默认值只是演示起点）。
 *
 * 分级规则（默认阈值，可在 strategy 里覆盖）：
 *   缺货   —— 可售+在途 ≤ 0（有销量时）
 *   紧急   —— 需要补货且可售天数 ≤ 3
 *   建议   —— 需要补货（闸门通过）
 *   滞销   —— 日均 < 0.5 且可售天数 ≥ 90
 *   充足   —— 其余
 */
import { addDays, assertDate } from './dates.mjs';
import { roundTo } from './math.mjs';

export const RISK_LEVELS = Object.freeze({
  STOCKOUT: '缺货',
  URGENT: '紧急',
  SUGGEST: '建议',
  SLOW: '滞销',
  SUFFICIENT: '充足',
});

/** 排序权重：越小越紧急 */
export const RISK_PRIORITY = Object.freeze({
  缺货: 0,
  紧急: 1,
  建议: 2,
  滞销: 3,
  充足: 4,
});

export const RISK_LEVEL_LIST = Object.freeze([
  RISK_LEVELS.STOCKOUT,
  RISK_LEVELS.URGENT,
  RISK_LEVELS.SUGGEST,
  RISK_LEVELS.SLOW,
  RISK_LEVELS.SUFFICIENT,
]);

export const DEFAULT_RISK_STRATEGY = Object.freeze({
  /** 可售天数 ≤ 该值 → 紧急 */
  urgent_cover_days: 3,
  /** 低于该日均 → 视为低销（滞销候选） */
  min_daily_sales: 0.5,
  /** 可售天数 ≥ 该值且低销 → 滞销 */
  slow_moving_cover_days: 90,
  /** 滞销回看天数（目前仅用于解释文案） */
  slow_moving_days: 30,
});

/**
 * 可售天数 = (可售 + 在途) / 日均销量；日均 ≤ 0 时返回 Infinity（不参与"断货"判断）。
 * 用「可售+在途」而不是只看可售：在途货到之前不算断货。
 */
export function coverDays(available, avgDaily) {
  const avg = Number(avgDaily);
  if (!(avg > 0)) return Infinity;
  return Math.max(0, Number(available) || 0) / avg;
}

/** 预计断货日 = asOf + floor(可售天数)；可售天数非有限值 → null */
export function stockoutDate(cover, asOf) {
  assertDate(asOf, 'asOf');
  if (!Number.isFinite(cover)) return null;
  return addDays(asOf, Math.max(0, Math.floor(cover)));
}

/**
 * 风险分级（纯函数）
 * @param {{
 *   asOf: string,
 *   sellable?: number, in_transit?: number,
 *   avg_daily_exact?: number, suggest_num?: number, guard_alert?: boolean,
 *   stale?: boolean,
 *   strategy?: Partial<typeof DEFAULT_RISK_STRATEGY>
 * }} input
 * @returns {{level:string, priority:number, reasons:string[], cover_days:number|null,
 *            stockout_date:string|null, strategy:object, provenance:'enhancement'}}
 */
export function classifyRisk(input = {}) {
  const { asOf } = input;
  assertDate(asOf, 'asOf');
  const strategy = { ...DEFAULT_RISK_STRATEGY, ...(input.strategy ?? {}) };

  const avg = Math.max(0, Number(input.avg_daily_exact) || 0);
  const sellable = Number(input.sellable) || 0;
  const inTransit = Math.max(0, Number(input.in_transit) || 0);
  const available = Math.max(0, sellable) + inTransit;
  const suggestNum = Math.max(0, Number(input.suggest_num) || 0);
  const cover = coverDays(available, avg);

  /** @type {string[]} */
  const reasons = [];
  let level;

  if (avg > 0 && available <= 0) {
    level = RISK_LEVELS.STOCKOUT;
    reasons.push('可售库存 + 在途库存 为 0，已断货');
  } else if (suggestNum > 0 && cover <= strategy.urgent_cover_days) {
    level = RISK_LEVELS.URGENT;
    reasons.push(`需要补货且可售天数 ${roundTo(cover, 2)} ≤ ${strategy.urgent_cover_days} 天`);
  } else if (suggestNum > 0) {
    level = RISK_LEVELS.SUGGEST;
    reasons.push('低库存预警（闸门通过），需要补货');
  } else if (avg < strategy.min_daily_sales && cover >= strategy.slow_moving_cover_days) {
    level = RISK_LEVELS.SLOW;
    reasons.push(
      `日均 ${roundTo(avg, 4)} < ${strategy.min_daily_sales} 且可售天数 ${Number.isFinite(cover) ? roundTo(cover, 0) : '∞'} ≥ ${strategy.slow_moving_cover_days}`,
    );
  } else {
    level = RISK_LEVELS.SUFFICIENT;
    reasons.push('库存充足，未触发低库存预警');
  }

  if (input.guard_alert) reasons.push('低库存预警（实物+在途 < 预警下限，见 H4）');
  if (input.stale) reasons.push('数据过期：快照或销量停留在数天前');

  return {
    level,
    priority: RISK_PRIORITY[level] ?? 9,
    reasons,
    cover_days: Number.isFinite(cover) ? roundTo(cover, 2) : null,
    stockout_date: stockoutDate(cover, asOf),
    strategy,
    provenance: 'enhancement',
  };
}
