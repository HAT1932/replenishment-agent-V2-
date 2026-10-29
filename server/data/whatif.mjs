/**
 * whatif.mjs — What-if 确定性重算（PRD US-02 / 报告 §4.3#20）
 * ---------------------------------------------------------------------------
 * 为什么必须服务端重算：A 版（Python）的 What-if 是让 LLM"估"的，数字不可追溯。
 * 这里改成：**改参数 → 调同一个域内核重算 → 给出差额与因子变化**，LLM 只负责解释结果。
 *
 * 允许覆盖的参数（白名单，防止模型随口改口径）：
 *   purchase_cycle_days（补货前置期/采购周期）
 *   coverage_days（目标可售天数）
 *   safety_days（缓冲天数）
 *   service_level（σ 方案的服务水平）
 *   expected_arrival（预计到货日）
 */
import { addDays } from '../domain/dates.mjs';
import { DomainError } from '../domain/errors.mjs';
import { AVG_SALES_WINDOW, PLAN_TYPES } from '../domain/plans.mjs';
import { computeDocumentedSuggestion, computeSigmaSuggestion } from '../domain/suggestion.mjs';
import {
  getHolidayDates,
  getInventory,
  getPlan,
  getSales,
  getSafetyConfig,
  getSeedDate,
  getSkuByCode,
  listPlans,
} from './repository.mjs';

/** 允许 What-if 覆盖的参数及其边界 */
export const WHATIF_BOUNDS = Object.freeze({
  purchase_cycle_days: { min: 1, max: 90, int: true, label: '补货前置期/采购周期' },
  coverage_days: { min: 1, max: 180, int: true, label: '目标可售天数' },
  safety_days: { min: 0, max: 60, int: false, label: '缓冲天数' },
  service_level: { min: 0.5, max: 0.999, int: false, label: '服务水平（σ 方案）' },
});

function pickPlan(db, planId) {
  if (planId !== undefined && planId !== null && planId !== '') {
    const plan = getPlan(db, planId);
    if (!plan) throw new DomainError('NOT_FOUND', `补货方案 ${planId} 不存在`);
    return plan;
  }
  const plans = listPlans(db);
  if (!plans.length) throw new DomainError('NOT_FOUND', '系统没有任何补货方案');
  return plans[0];
}

/** 校验覆盖参数，返回 {applied, rejected} */
export function validateOverrides(overrides = {}) {
  const applied = {};
  const rejected = [];
  for (const [key, raw] of Object.entries(overrides ?? {})) {
    const bounds = WHATIF_BOUNDS[key];
    if (!bounds) {
      rejected.push({ key, reason: `不支持覆盖 ${key}（白名单：${Object.keys(WHATIF_BOUNDS).join(' / ')}）` });
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      rejected.push({ key, reason: '不是合法数字' });
      continue;
    }
    if (bounds.int && !Number.isInteger(value)) {
      rejected.push({ key, reason: '必须是整数' });
      continue;
    }
    if (value < bounds.min || value > bounds.max) {
      rejected.push({ key, reason: `超出范围 ${bounds.min}–${bounds.max}` });
      continue;
    }
    applied[key] = value;
  }
  return { applied, rejected };
}

function computeOnce({ plan, sku, inventory, sales, safetyConfig, holidays, asOf, expectedArrival, scope }) {
  const input = { plan, sku, inventory, sales, safetyConfig, holidays, asOf, expectedArrival, scope };
  return plan.plan_type === PLAN_TYPES.SIGMA ? computeSigmaSuggestion(input) : computeDocumentedSuggestion(input);
}

function summarize(suggestion) {
  return {
    suggest_num: suggestion.suggest_num,
    suggest_raw: suggestion.suggest_raw,
    suggest_raw_exact: suggestion.suggest_raw_exact,
    amount: suggestion.amount,
    stock_lower: suggestion.stock_lower,
    stock_upper: suggestion.stock_upper,
    avg_daily_sales: suggestion.avg_daily_sales,
    formula_text: suggestion.formula_text,
    formula_expr: suggestion.formula_expr,
    factors: (suggestion.factors ?? []).map((item) => ({
      name: item.name,
      value: item.value,
      unit: item.unit,
      impact: item.impact,
      direction: item.direction,
    })),
    urgency: suggestion.urgency?.level ?? null,
    confidence: suggestion.confidence?.level ?? null,
    provenance: suggestion.provenance,
    plan: {
      plan_id: suggestion.plan_id,
      plan_name: suggestion.plan_name,
      plan_type: suggestion.plan_type,
    },
  };
}

/**
 * What-if：用同一个域内核在覆盖参数下重算，返回 before/after/delta。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} skuCode
 * @param {{as_of?:string, plan_id?:any, overrides?:object, expected_arrival?:string, scope?:'store'|'headquarters'}} options
 */
export function buildWhatIf(db, skuCode, { as_of, plan_id, overrides = {}, scope = 'store' } = {}) {
  const plan = pickPlan(db, plan_id);
  const asOf = as_of ? String(as_of) : getSeedDate(db);
  const sku = getSkuByCode(db, skuCode);
  if (!sku) throw new DomainError('NOT_FOUND', `SKU ${skuCode} 不存在`);

  const { applied, rejected } = validateOverrides(overrides);
  if (!Object.keys(applied).length && !rejected.length) {
    throw new DomainError('VALIDATION_ERROR', 'What-if 至少需要一个覆盖参数（purchase_cycle_days / coverage_days / safety_days / service_level）');
  }
  if (!Object.keys(applied).length) {
    throw new DomainError('VALIDATION_ERROR', `没有可用覆盖参数：${rejected.map((item) => item.reason).join('；')}`);
  }

  const inventory = getInventory(db, sku.id);
  const salesFrom = addDays(asOf, -Math.max(AVG_SALES_WINDOW, 120));
  const sales = getSales(db, sku.id, { from: salesFrom, to: asOf });
  const safetyConfig = getSafetyConfig(db);
  const holidays = getHolidayDates(db);

  const baseCtx = { plan, sku, inventory, sales, safetyConfig, holidays, asOf, scope };
  const before = computeOnce(baseCtx);

  const overriddenPlan = { ...plan, config: { ...plan.config, ...applied } };
  const after = computeOnce({ ...baseCtx, plan: overriddenPlan });

  const deltaQty = (after.suggest_num ?? 0) - (before.suggest_num ?? 0);

  return {
    as_of: asOf,
    sku: {
      sku_code: sku.code,
      product_name: sku.name,
      spec: sku.spec,
      unit: sku.unit,
      store_name: sku.store_name,
    },
    plan: { plan_id: plan.plan_id, plan_name: plan.plan_name, plan_type: plan.plan_type },
    overrides: {
      applied,
      rejected,
      labels: Object.fromEntries(Object.keys(applied).map((key) => [key, WHATIF_BOUNDS[key].label])),
    },
    before: summarize(before),
    after: summarize(after),
    delta: {
      qty: deltaQty,
      amount: Number((Number(after.amount ?? 0) - Number(before.amount ?? 0)).toFixed(2)),
      qty_pct: before.suggest_num ? Number(((deltaQty / before.suggest_num) * 100).toFixed(1)) : null,
    },
    /** 差额的因子级来源：哪些项变了、变了多少 */
    factor_delta: (after.factors ?? [])
      .map((item) => {
        const prev = (before.factors ?? []).find((candidate) => candidate.name === item.name);
        const prevImpact = prev ? prev.impact : 0;
        return {
          name: item.name,
          before: prevImpact,
          after: item.impact,
          delta: Number((item.impact - prevImpact).toFixed(4)),
        };
      })
      .filter((item) => Math.abs(item.delta) > 1e-9),
    notes: [
      'What-if 由服务端用同一个确定性内核重算，不是模型估算（报告 §4.3#20）',
      `未覆盖的参数保持方案原值${Object.keys(applied).length ? `；本轮覆盖：${Object.entries(applied)
        .map(([key, value]) => `${WHATIF_BOUNDS[key].label}=${value}`)
        .join('、')}` : ''}`,
    ],
    /** 预计到货日可能随前置期变化（即使数量不变，也要让用户看见） */
    arrival: {
      before: before.expected_arrival,
      after: after.expected_arrival,
      changed: before.expected_arrival !== after.expected_arrival,
    },
    /** 参数影响面说明：避免"改了没反应"的困惑 */
    parameter_effects: {
      purchase_cycle_days: '方案 1/2 只影响预计到货日；方案 3 同时影响"日均×周期"项与系数窗口',
      coverage_days: '方案 1/3 的需求侧天数；σ 方案的目标可售天数',
      safety_days: '安全库存缓冲天数（影响预警下限/目标库存）',
      service_level: '仅 σ 方案：服务水平 → z 值 → 安全库存',
    },
    plan_params: {
      purchase_cycle_days: plan.config?.purchase_cycle_days,
      coverage_days: plan.config?.coverage_days,
      safety_days: plan.config?.safety_days,
      service_level: plan.config?.service_level,
    },
    provenance: after.provenance,
    assumptions: after.assumptions ?? [],
  };
}
