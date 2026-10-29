/**
 * safety.mjs — 库存预警上下限 & 低库存闸门
 * ---------------------------------------------------------------------------
 * 文档依据（A 级）：
 *  - 「库存预警」固定值/动态值两种模式（安全库存使用教程 detail_5_5-2-42123）
 *  - 动态值：下限 = 最少可售天数 × 近15天日均销量；上限 = 最多可售天数 × 近15天日均销量
 *  - 补货建议闸门：`实物库存 + 在途库存 < 库存预警下限`（补货建议使用教程 22065 正文）
 *
 * 已知冲突（H4）：42123 用的是「实时库存 < 下限」。本实现把口径做成显式 policy，
 * 默认采用 22065 正文口径（physical_plus_transit），并在结果里回带 assumption id。
 */
import { validationError } from './errors.mjs';
import { ceilInt, roundTo } from './math.mjs';
import { SAFETY_STOCK_MODES, resolveSafetyStockConfig } from './plans.mjs';

/** 低库存判定口径 */
export const GATE_POLICIES = Object.freeze({
  /** 实物 + 在途 < 下限（教程正文口径，默认） */
  PHYSICAL_PLUS_TRANSIT: 'physical_plus_transit',
  /** 实时(实物)库存 < 下限（安全库存教程口径） */
  REALTIME: 'realtime',
});

export const GATE_POLICY_LABEL = Object.freeze({
  physical_plus_transit: '实物库存 + 在途库存 < 库存预警下限',
  realtime: '实时库存 < 库存预警下限',
});

function nonNegNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw validationError(`${field} 必须是非负数字，收到 ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * 解析库存预警上下限。
 * 内部保留 exact（不取整），落地值 `lower`/`upper` 取整供闸门与展示（H5）。
 * @param {{config?: object, avg_daily_exact?: number}} input
 * @returns {{
 *   mode:'fixed'|'dynamic',
 *   lower_exact:number, upper_exact:number, lower:number, upper:number,
 *   min_sellable_days:number|null, max_sellable_days:number|null,
 *   formula_text:string, assumptions:string[]
 * }}
 */
export function resolveSafetyStock({ config, avg_daily_exact: avg = 0 } = {}) {
  const cfg = resolveSafetyStockConfig(config);
  const avgExact = Math.max(0, Number(avg) || 0);
  let lowerExact;
  let upperExact;
  let formulaText;

  if (cfg.mode === SAFETY_STOCK_MODES.FIXED) {
    lowerExact = nonNegNumber(cfg.lower_fixed, 'lower_fixed');
    upperExact = nonNegNumber(cfg.upper_fixed, 'upper_fixed');
    formulaText = '固定值：下限/上限直接取配置值';
  } else {
    lowerExact = nonNegNumber(cfg.min_sellable_days, 'min_sellable_days') * avgExact;
    upperExact = nonNegNumber(cfg.max_sellable_days, 'max_sellable_days') * avgExact;
    formulaText = `动态值：下限 = ${cfg.min_sellable_days} 天 × 日均 ${roundTo(avgExact, 4)}；上限 = ${cfg.max_sellable_days} 天 × 日均`;
  }

  let lower = ceilInt(lowerExact);
  let upper = ceilInt(upperExact);
  if (upper < lower) upper = lower;

  return {
    mode: cfg.mode,
    lower_exact: lowerExact,
    upper_exact: upperExact,
    lower,
    upper,
    min_sellable_days: cfg.mode === SAFETY_STOCK_MODES.DYNAMIC ? cfg.min_sellable_days : null,
    max_sellable_days: cfg.mode === SAFETY_STOCK_MODES.DYNAMIC ? cfg.max_sellable_days : null,
    formula_text: formulaText,
    assumptions: cfg.mode === SAFETY_STOCK_MODES.DYNAMIC ? ['H5'] : [],
  };
}

/**
 * 低库存闸门（补货建议的**唯一**前置条件）
 * @param {{stock_num:number, in_transit:number, stock_lower:number,
 *          policy?: 'physical_plus_transit'|'realtime'}} input
 * @returns {{alert:boolean, policy:string, lhs:number, rhs:number, text:string,
 *           expressions:string[], assumption_id:string}}
 */
export function evaluateLowStockGate({
  stock_num,
  in_transit = 0,
  stock_lower,
  policy = GATE_POLICIES.PHYSICAL_PLUS_TRANSIT,
} = {}) {
  if (!Object.values(GATE_POLICIES).includes(policy)) {
    throw validationError(`未知闸门口径：${policy}（可选 ${Object.values(GATE_POLICIES).join('/')}）`);
  }
  const stock = Number(stock_num) || 0;
  const transit = Number(in_transit) || 0;
  const lower = Math.max(0, Number(stock_lower) || 0);

  const lhs = policy === GATE_POLICIES.REALTIME ? stock : stock + transit;
  const alert = lhs < lower;
  const parts =
    policy === GATE_POLICIES.REALTIME
      ? [`实时库存 ${stock}`]
      : [`实物库存 ${stock}`, `在途库存 ${transit}`];

  return {
    alert,
    policy,
    lhs,
    rhs: lower,
    text: `${parts.join(' + ')} = ${lhs} ${alert ? '<' : '≥'} 库存预警下限 ${lower}`,
    expressions: [
      `${parts.join(' + ')} = ${lhs}`,
      `${lhs} ${alert ? '<' : '≥'} ${lower}`,
    ],
    assumption_id: 'H4',
  };
}

/** 兼容简名 */
export function isLowStockAlert(input) {
  return evaluateLowStockGate(input).alert;
}
