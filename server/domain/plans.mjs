/**
 * plans.mjs — 补货方案与预警配置（文档口径常量 + 裁剪）
 * ---------------------------------------------------------------------------
 * 方案 1/2/3 的公式文案**逐字**来自有赞帮助中心《补货建议使用教程》(detail_5_5-2-22065)，
 * 与后台「新建模板」页（截图 03）界面文案一致。方案 4（σ）为本实现增强，绝不标 documented。
 */
import { validationError } from './errors.mjs';

export const AVG_SALES_WINDOW = 15;

export const PLAN_TYPES = Object.freeze({
  AVG_DAILY: 'avg_daily',
  STOCK_UPPER: 'stock_upper',
  CUSTOM: 'custom',
  SIGMA: 'sigma',
});

export const PLAN_TYPE_LABEL = Object.freeze({
  avg_daily: '按日均销量补货',
  stock_upper: '按库存上限补货',
  custom: '自定义方案',
  sigma: '按需求波动补货（增强）',
});

export const PLAN_TYPE_ORDER = ['avg_daily', 'stock_upper', 'custom', 'sigma'];

/** documented = 有赞文档/截图已证实；enhancement = 本实现增强 */
export const PROVENANCE = Object.freeze({
  avg_daily: 'documented',
  stock_upper: 'documented',
  custom: 'documented',
  sigma: 'enhancement',
});

export const SAFETY_STOCK_MODES = Object.freeze({ FIXED: 'fixed', DYNAMIC: 'dynamic' });

export const DEFAULT_PLAN_CONFIG = Object.freeze({
  plan_type: PLAN_TYPES.AVG_DAILY,
  /** 采购周期（天）：本次补货与下一次补货发起日的间隔（文档定义） */
  purchase_cycle_days: 7,
  /** 可售天数：仅「按日均销量补货」方案使用（文档：公式里的可售天数） */
  coverage_days: 15,
  coefficient_enabled: 0,
  holiday_coefficient_enabled: 0,
  holiday_coefficient: 1.2,
  weekend_coefficient_enabled: 0,
  weekend_coefficient: 1.1,
  /* —— 增强（σ 方案 / 装箱）—— */
  service_level: 0.95,
  safety_days: 3,
  forecast_window: 14,
  seasonality: 1,
  trend_damping: 0.5,
  lead_time_days: 7,
  moq: 1,
  pack_size: 1,
});

export const PLAN_BOUNDS = Object.freeze({
  purchase_cycle_days: { min: 1, max: 90, integer: true },
  coverage_days: { min: 1, max: 180, integer: true },
  holiday_coefficient: { min: 0.1, max: 5 },
  weekend_coefficient: { min: 0.1, max: 5 },
  service_level: { min: 0.5, max: 0.999 },
  safety_days: { min: 0, max: 60 },
  forecast_window: { min: 3, max: 90, integer: true },
  lead_time_days: { min: 1, max: 120, integer: true },
  moq: { min: 1, max: 10000, integer: true },
  pack_size: { min: 1, max: 1000, integer: true },
});

export const DEFAULT_SAFETY_STOCK = Object.freeze({
  mode: SAFETY_STOCK_MODES.DYNAMIC,
  lower_fixed: 10,
  upper_fixed: 100,
  min_sellable_days: 7,
  max_sellable_days: 30,
});

export const SAFETY_STOCK_BOUNDS = Object.freeze({
  lower_fixed: { min: 0, max: 100000, integer: true },
  upper_fixed: { min: 0, max: 1000000, integer: true },
  min_sellable_days: { min: 0, max: 180, integer: true },
  max_sellable_days: { min: 1, max: 365, integer: true },
});

function clampNumber(value, bounds, fallback, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (bounds.integer) {
    // 采购周期/可售天数等必须是整数：给小数直接报错，避免 v1 的「7.5 天公式 vs 8 天窗口」
    const rounded = Math.round(n);
    if (Math.abs(n - rounded) > 1e-9 && value !== undefined && value !== null && value !== '') {
      throw validationError(`${field} 必须为整数（天），收到 ${n}`);
    }
    return Math.min(bounds.max, Math.max(bounds.min, rounded));
  }
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

/** 把方案配置裁剪/校验为合法值 */
export function resolvePlanConfig(rawConfig = {}) {
  const out = { ...DEFAULT_PLAN_CONFIG };
  for (const [k, v] of Object.entries(rawConfig ?? {})) {
    if (k in DEFAULT_PLAN_CONFIG && v !== undefined && v !== null && v !== '') out[k] = v;
  }
  if (!PLAN_TYPE_ORDER.includes(out.plan_type)) {
    throw validationError(`未知方案类型：${out.plan_type}（可选 ${PLAN_TYPE_ORDER.join('/')}）`);
  }
  for (const [k, bounds] of Object.entries(PLAN_BOUNDS)) {
    out[k] = clampNumber(out[k], bounds, DEFAULT_PLAN_CONFIG[k], k);
  }
  for (const k of [
    'coefficient_enabled',
    'holiday_coefficient_enabled',
    'weekend_coefficient_enabled',
    'seasonality',
  ]) {
    out[k] = Number(out[k]) > 0 ? 1 : 0;
  }
  return out;
}

/** 把库存预警配置裁剪/校验为合法值 */
export function resolveSafetyStockConfig(raw = {}) {
  const out = { ...DEFAULT_SAFETY_STOCK };
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (k in DEFAULT_SAFETY_STOCK && v !== undefined && v !== null && v !== '') out[k] = v;
    }
  }
  out.mode = Object.values(SAFETY_STOCK_MODES).includes(out.mode) ? out.mode : SAFETY_STOCK_MODES.DYNAMIC;
  for (const [k, bounds] of Object.entries(SAFETY_STOCK_BOUNDS)) {
    out[k] = clampNumber(out[k], bounds, DEFAULT_SAFETY_STOCK[k], k);
  }
  if (out.upper_fixed < out.lower_fixed) out.upper_fixed = out.lower_fixed;
  if (out.max_sellable_days < out.min_sellable_days) out.max_sellable_days = out.min_sellable_days;
  return out;
}

/** 方案公式展示文案（与官方原文逐字一致；σ 行标注为增强） */
export function formulaText(plan) {
  const t = plan?.plan_type ?? PLAN_TYPES.AVG_DAILY;
  if (t === PLAN_TYPES.AVG_DAILY) {
    return '建议数量 = 近15天日均销量 × 可售天数 + 库存预警下限 − 可售库存';
  }
  if (t === PLAN_TYPES.STOCK_UPPER) {
    return '建议数量 = 库存上限 − 当前实物库存';
  }
  if (t === PLAN_TYPES.CUSTOM) {
    const coef = Number(plan?.coefficient_enabled) ? ' × 综合系数' : '';
    return `建议数量 = (近15天日均销量 × 采购周期 + 库存预警下限 − 可售库存 − 在途库存)${coef}`;
  }
  return '建议数量 = ceil_to_pack( 预测日均 × (可售天数 + 采购提前期) + 安全库存 − 可售库存 − 在途库存 )';
}

/** 综合系数说明（帮助文案，含官方算例） */
export function coefficientHint(plan) {
  return (
    '综合系数 = Σ(窗口内每日系数) / 窗口天数；窗口 = [预计到货日, 预计到货日 + 采购周期 − 1]。' +
    '工作日系数按 1；双休日与重大节假日系数可分别配置；同一天命中多个系数时取其中较大者。' +
    `官方算例：周期 5 天、其中 2 天双休日系数 1.1、1 天节假日系数 1.2 且与双休日重叠 → (1+1+1+1.1+1.2)/5 = 1.06` +
    (Number(plan?.coefficient_enabled) ? '' : '（当前方案未启用综合系数）')
  );
}
