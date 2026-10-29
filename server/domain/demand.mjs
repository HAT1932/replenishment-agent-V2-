/**
 * demand.mjs — 需求窗口与预测（修 v1 的 D1）
 * ---------------------------------------------------------------------------
 * v1 的 `avgDailySales()` 取「最后 N 条记录」，一旦出库明细缺日（零出库日不落行），
 * 日均销量会成倍高估（实测同一份数据 2.0 vs 0.667，建议量 40 vs 21，严重时差 5–7 倍）。
 *
 * 本实现：
 *   1) 以 `asOf` 为锚点补齐「近 N 个自然日」的**稠密日期序列**，缺日 qty=0（记 imputed）；
 *   2) 分母恒为 N 天（符合 H2 假设：含零销量日）；
 *   3) 同时返回数据新鲜度 `staleness_days`，供上层做「数据过期」决策（H4 之外的独立护栏）。
 *
 * 出库类型维度（v1 缺失）：总部/门店口径不同，见 DEMAND_SCOPES。
 */
import { addDays, assertDate, diffDays, lastNDates, weekdayIndex, WEEKDAY_LABEL } from './dates.mjs';
import { validationError } from './errors.mjs';
import { linearSlope, roundTo, stddev, weightedMovingAverage } from './math.mjs';
import { AVG_SALES_WINDOW } from './plans.mjs';

/** 出库类型（有赞口径里日均销量由多类出库构成） */
export const OUTBOUND_TYPES = Object.freeze(['sale', 'transfer', 'delivery']);

/**
 * 门店口径：门店、网店销售出库 + 调拨出库
 * 总部口径：网店订单总部发货出库 + 仓库配送出库 + 调拨出库
 */
export const DEMAND_SCOPES = Object.freeze({
  store: Object.freeze(['sale', 'transfer']),
  headquarters: Object.freeze(['sale', 'transfer', 'delivery']),
});

const DEFAULT_FRESHNESS_DAYS = 1;

function normalizeInclude(include, scope) {
  if (include === undefined || include === null) {
    return [...(DEMAND_SCOPES[scope] ?? DEMAND_SCOPES.store)];
  }
  if (!Array.isArray(include) || include.length === 0) {
    throw validationError('include 必须是非空的出库类型数组（sale|transfer|delivery）');
  }
  const out = [];
  for (const t of include) {
    if (!OUTBOUND_TYPES.includes(t)) {
      throw validationError(`未知出库类型：${t}（可选 ${OUTBOUND_TYPES.join('/')}）`);
    }
    out.push(t);
  }
  return out;
}

/**
 * 构建稠密日序列（升序，含零销量日）
 * @param {{sales: Array<{date:string,qty:number,outbound_type?:string}>, asOf: string, days: number, include?: string[], scope?: string}} input
 * @returns {Array<{date:string, qty:number, imputed:boolean}>}
 */
export function buildDenseSeries({ sales, asOf, days, include, scope = 'store' }) {
  assertDate(asOf, 'asOf');
  const n = Math.max(1, Math.trunc(Number(days) || 1));
  const types = normalizeInclude(include, scope);
  const dates = lastNDates(asOf, n);
  const wanted = new Set(dates);
  /** @type {Map<string, number>} */
  const qtyByDate = new Map(dates.map((d) => [d, 0]));
  /** @type {Set<string>} 真正出现过记录（哪怕 qty=0）的日期 */
  const recorded = new Set();

  for (const row of sales ?? []) {
    if (!row || typeof row.date !== 'string') continue;
    const date = row.date.slice(0, 10);
    if (!wanted.has(date)) continue;
    const type = row.outbound_type ?? 'sale';
    if (!types.includes(type)) continue;
    const qty = Number(row.qty);
    if (!Number.isFinite(qty)) continue;
    qtyByDate.set(date, (qtyByDate.get(date) ?? 0) + qty);
    recorded.add(date);
  }

  return dates.map((date) => ({
    date,
    qty: Math.max(0, qtyByDate.get(date) ?? 0),
    imputed: !recorded.has(date),
  }));
}

/**
 * 近 N 个自然日的需求窗口（含缺日补 0、口径过滤、数据新鲜度）
 * @returns {{
 *   asOf:string, days:number, include:string[], scope:string,
 *   points:Array<{date:string,qty:number,imputed:boolean}>,
 *   total:number, avg_daily_exact:number,
 *   recorded_days:number, imputed_days:number,
 *   last_recorded_date:string|null, staleness_days:number|null,
 *   freshness_days:number, status:'ok'|'stale',
 *   assumptions:string[]
 * }}
 */
export function demandWindow({
  sales,
  asOf,
  days = AVG_SALES_WINDOW,
  include,
  scope = 'store',
  freshness_days = DEFAULT_FRESHNESS_DAYS,
} = {}) {
  assertDate(asOf, 'asOf');
  const n = Math.max(1, Math.trunc(Number(days) || AVG_SALES_WINDOW));
  const points = buildDenseSeries({ sales, asOf, days: n, include, scope });
  const types = normalizeInclude(include, scope);

  const total = points.reduce((a, p) => a + p.qty, 0);
  const imputedDays = points.filter((p) => p.imputed).length;

  // 新鲜度：最近一条（本口径内）出库记录距 asOf 的天数
  let lastRecordedDate = null;
  for (const row of sales ?? []) {
    if (!row || typeof row.date !== 'string') continue;
    const date = row.date.slice(0, 10);
    const type = row.outbound_type ?? 'sale';
    if (!types.includes(type)) continue;
    if (date > asOf) continue;
    if (lastRecordedDate === null || date > lastRecordedDate) lastRecordedDate = date;
  }
  const staleness =
    lastRecordedDate === null ? null : Math.max(0, diffDays(lastRecordedDate, asOf));
  const freshLimit = Math.max(0, Math.trunc(Number(freshness_days) || 0));
  const status = staleness === null || staleness > freshLimit ? 'stale' : 'ok';

  return {
    asOf,
    days: n,
    include: types,
    scope,
    points,
    total: roundTo(total, 6),
    // 分母恒为 N 天（H2：含零销量日）
    avg_daily_exact: total / n,
    recorded_days: points.length - imputedDays,
    imputed_days: imputedDays,
    last_recorded_date: lastRecordedDate,
    staleness_days: staleness,
    freshness_days: freshLimit,
    status,
    assumptions: ['H2', 'H7'],
  };
}

/**
 * 星期因子（去季节化基准比例为 1；小样本向 1 收缩）
 * @param {Array<{date:string,qty:number}>} series 稠密升序
 */
export function weekdayFactors(series, prior = 2) {
  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  let total = 0;
  for (const row of series) {
    const wd = weekdayIndex(row.date);
    sums[wd] += row.qty;
    counts[wd] += 1;
    total += row.qty;
  }
  const n = series.length;
  const allMean = n > 0 ? total / n : 0;
  const factors = new Array(7).fill(1);
  if (allMean <= 0) return factors;
  for (let wd = 0; wd < 7; wd++) {
    if (counts[wd] === 0) continue;
    const mean = sums[wd] / counts[wd];
    const shrink = counts[wd] / (counts[wd] + prior);
    const raw = 1 + shrink * (mean / allMean - 1);
    factors[wd] = Math.min(2, Math.max(0.5, raw));
  }
  return factors;
}

/**
 * 预测日均销量（增强，provenance=enhancement）
 *  - 去季节化：qty / weekdayFactor
 *  - 基准：加权移动平均
 *  - 趋势：最小二乘斜率 × 阻尼，外推到提前期一半，裁剪 ±30%
 *  - 规划期 < 7 天时乘规划期星期因子均值（>=7 天各星期已平均掉，恒为 1）
 */
export function forecastDemand({
  sales,
  asOf,
  params = {},
  include,
  scope = 'store',
} = {}) {
  assertDate(asOf, 'asOf');
  const window = Math.max(3, Math.trunc(Number(params.forecast_window) || 14));
  const leadTime = Math.max(0, Number(params.lead_time_days) || 0);
  const coverage = Math.max(0, Number(params.coverage_days) || 0);
  const seasonalityEnabled = Number(params.seasonality) > 0;

  // 用足够长的稠密序列估计星期因子与趋势
  const lookback = Math.max(window, 28) + (seasonalityEnabled ? 14 : 0);
  const dense = buildDenseSeries({ sales, asOf, days: lookback, include, scope });
  const factors = seasonalityEnabled ? weekdayFactors(dense) : new Array(7).fill(1);

  const tail = dense.slice(-window);
  const deseason = tail.map((p) => {
    const f = factors[weekdayIndex(p.date)];
    return f > 0 && Number.isFinite(f) ? p.qty / f : p.qty;
  });

  const baseWma = weightedMovingAverage(deseason, window);
  const slope = linearSlope(deseason);
  const dampedSlope = (Number(params.trend_damping) || 0) * slope;
  const rawTrendAdj = dampedSlope * (leadTime / 2);
  const trendAdj = Math.max(-0.3 * baseWma, Math.min(0.3 * baseWma, rawTrendAdj));

  const horizon = Math.round(leadTime + coverage);
  let horizonFactor = 1;
  if (seasonalityEnabled && horizon > 0 && horizon < 7) {
    let sum = 0;
    const startW = weekdayIndex(asOf);
    for (let i = 0; i < horizon; i++) sum += factors[(startW + i) % 7];
    horizonFactor = sum / horizon;
  }

  const forecastExact = Math.max(0, baseWma + trendAdj) * horizonFactor;
  return {
    forecast_daily_exact: forecastExact,
    forecast_daily: roundTo(forecastExact, 4),
    base_wma_exact: baseWma,
    trend_exact: slope,
    trend_adj_exact: trendAdj,
    horizon_weekday_factor: roundTo(horizonFactor, 4),
    weekday_factors: factors.map((f) => roundTo(f, 4)),
    weekday_labels: factors.map((_, i) => WEEKDAY_LABEL[i]),
    seasonality_enabled: seasonalityEnabled,
    window,
    observations: tail.length,
    assumptions: ['H7', 'H10'],
  };
}

/** 日需求标准差（去季节化后残差，n-1） */
export function demandSigmaDaily({ sales, asOf, params = {}, include, scope = 'store' } = {}) {
  const window = Math.max(2, Math.trunc(Number(params.forecast_window) || 14));
  const lookback = Math.max(window, 28) + 14;
  const dense = buildDenseSeries({ sales, asOf, days: lookback, include, scope });
  const seasonalityEnabled = Number(params.seasonality) > 0;
  const factors = seasonalityEnabled ? weekdayFactors(dense) : new Array(7).fill(1);
  const tail = dense.slice(-window);
  const level = tail.map((p) => {
    const f = factors[weekdayIndex(p.date)];
    return f > 0 && Number.isFinite(f) ? p.qty / f : p.qty;
  });
  return { sigma_daily_exact: stddev(level), observations: tail.length, assumptions: ['H7', 'H10'] };
}

/** 近 N 天合计（辅助） */
export function sumWindow(sales, asOf, days, opts = {}) {
  const w = demandWindow({ sales, asOf, days, ...opts });
  return w.total;
}

/** 生成「近 N 天」的日期标签（给 UI/工具展示用） */
export function windowRangeLabel(asOf, days) {
  return `${addDays(asOf, -(days - 1))} ~ ${asOf}`;
}
