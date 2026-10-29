/**
 * workbench.mjs — 决策工作台读模型（**本实现增强，非有赞口径**）
 * ---------------------------------------------------------------------------
 * 补货建议表回答"每一行该补多少"；工作台回答"我现在该先处理谁、会断货吗、钱压在哪"。
 * 三条纪律：
 *  1) 数量口径仍来自 `domain/suggestion.mjs`（documented），本文件**不重算数量**；
 *  2) 风险分级/可售天数/断货日/资金占用属于增强层，整页与每行都标注 `risk_provenance='enhancement'`；
 *  3) KPI 在服务端算。
 */
import { addDays } from '../domain/dates.mjs';
import { DomainError, toErrorEnvelope } from '../domain/errors.mjs';
import { roundTo } from '../domain/math.mjs';
import { AVG_SALES_WINDOW, PLAN_TYPES, formulaText } from '../domain/plans.mjs';
import { ASSUMPTIONS } from '../domain/assumptions.mjs';
import { DEFAULT_RISK_STRATEGY, RISK_LEVEL_LIST, classifyRisk } from '../domain/risk.mjs';
import {
  computeDocumentedSuggestion,
  computeSigmaSuggestion,
} from '../domain/suggestion.mjs';
import {
  getHolidayDates,
  getInventory,
  getPlan,
  getSales,
  getSafetyConfig,
  getSeedDate,
  getSkuByCode,
  listPlans,
  listSkus,
} from './repository.mjs';

const MAX_PAGE_SIZE = 200;
const SORTABLE = new Set(['risk_priority', 'cover_days', 'amount', 'suggest_num', 'inventory_capital', 'avg_daily_sales']);

function validatePage({ page, page_size }) {
  const p = Math.max(1, Math.trunc(Number(page) || 1));
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(page_size) || 50)));
  return { page: p, page_size: size };
}

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

function riskStrategy(q) {
  const pick = (key) => (q[key] === undefined || q[key] === null || q[key] === '' ? undefined : Number(q[key]));
  return {
    ...DEFAULT_RISK_STRATEGY,
    ...(pick('urgent_cover_days') !== undefined ? { urgent_cover_days: pick('urgent_cover_days') } : {}),
    ...(pick('slow_moving_cover_days') !== undefined ? { slow_moving_cover_days: pick('slow_moving_cover_days') } : {}),
    ...(pick('min_daily_sales') !== undefined ? { min_daily_sales: pick('min_daily_sales') } : {}),
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{plan_id?:any, store_id?:any, category?:string, keyword?:string, as_of?:string,
 *          risk?:string, sort?:string, order?:'asc'|'desc', page?:any, page_size?:any,
 *          scope?:'store'|'headquarters', urgent_cover_days?:number,
 *          slow_moving_cover_days?:number, min_daily_sales?:number}} q
 */
export function buildWorkbench(db, q = {}) {
  const plan = pickPlan(db, q.plan_id);
  const asOf = q.as_of ? String(q.as_of) : getSeedDate(db);
  const { page, page_size } = validatePage(q);
  const safetyConfig = getSafetyConfig(db);
  const holidays = getHolidayDates(db);
  const scope = q.scope === 'headquarters' ? 'headquarters' : 'store';
  const strategy = riskStrategy(q);
  const riskFilter = q.risk ? String(q.risk) : null;
  if (riskFilter && !RISK_LEVEL_LIST.includes(riskFilter)) {
    throw new DomainError('VALIDATION_ERROR', `risk 只能是 ${RISK_LEVEL_LIST.join(' / ')}`);
  }

  const skus = listSkus(db, { store_id: q.store_id, category: q.category, keyword: q.keyword });
  const salesFrom = addDays(asOf, -Math.max(AVG_SALES_WINDOW, 120));

  const rows = [];
  const skipped = [];
  for (const sku of skus) {
    try {
      const inventory = getInventory(db, sku.id);
      const sales = getSales(db, sku.id, { from: salesFrom, to: asOf });
      const input = { plan, sku, inventory, sales, safetyConfig, holidays, asOf, scope };
      const suggestion =
        plan.plan_type === PLAN_TYPES.SIGMA ? computeSigmaSuggestion(input) : computeDocumentedSuggestion(input);

      const stale = (suggestion.flags ?? []).includes('stale_data');
      const risk = classifyRisk({
        asOf,
        sellable: suggestion.sellable_stock,
        in_transit: suggestion.in_transit_stock,
        avg_daily_exact: suggestion.avg_daily_sales_exact,
        suggest_num: suggestion.suggest_num,
        guard_alert: suggestion.guard?.alert === true,
        stale,
        strategy,
      });

      const onHand = Number(suggestion.inventory?.on_hand ?? 0);
      const unitCost = Number(suggestion.unit_cost ?? 0);

      rows.push({
        sku_id: sku.id,
        sku_code: suggestion.sku_code,
        sku_no: suggestion.sku_no,
        product_name: suggestion.product_name,
        spec: suggestion.spec,
        unit: suggestion.unit,
        category: suggestion.category,
        store_id: sku.store_id ?? null,
        store_name: sku.store_name ?? '',
        supplier_name: suggestion.supplier_name,

        /* 事实层 */
        on_hand_stock: onHand,
        sellable_stock: suggestion.sellable_stock,
        in_transit_stock: suggestion.in_transit_stock,
        stock_lower: suggestion.stock_lower,
        stock_upper: suggestion.stock_upper,
        avg_daily_sales: suggestion.avg_daily_sales,
        avg_daily_sales_exact: suggestion.avg_daily_sales_exact,

        /* 建议层（documented，来自域层） */
        suggest_num: suggestion.suggest_num,
        apply_num: suggestion.apply_num,
        amount: suggestion.amount,
        unit_cost: unitCost,

        /* 决策层（enhancement） */
        cover_days: risk.cover_days,
        stockout_date: risk.stockout_date,
        risk_level: risk.level,
        risk_priority: risk.priority,
        risk_reasons: risk.reasons,
        inventory_capital: roundTo(onHand * unitCost, 2),

        plan_id: suggestion.plan_id,
        plan_type: suggestion.plan_type,
        provenance: suggestion.provenance,
        risk_provenance: 'enhancement',
        assumptions: [...new Set([...(suggestion.assumptions ?? []), 'H10'])],
        flags: suggestion.flags ?? [],
        guard: suggestion.guard ?? null,
      });
    } catch (err) {
      const env = toErrorEnvelope(err);
      skipped.push({ sku_code: sku.code, product_name: sku.name, code: env.code, message: env.message });
    }
  }

  const filtered = riskFilter ? rows.filter((row) => row.risk_level === riskFilter) : rows;

  const sortKey = SORTABLE.has(String(q.sort)) ? String(q.sort) : 'risk_priority';
  const order = q.order === 'asc' ? 'asc' : q.order === 'desc' ? 'desc' : sortKey === 'risk_priority' ? 'asc' : 'desc';
  const dir = order === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    const aNull = av === null || av === undefined || Number.isNaN(av);
    const bNull = bv === null || bv === undefined || Number.isNaN(bv);
    if (aNull && bNull) return (a.risk_priority ?? 9) - (b.risk_priority ?? 9);
    if (aNull) return 1;
    if (bNull) return -1;
    if (av !== bv) return (av - bv) * dir;
    return (a.risk_priority ?? 9) - (b.risk_priority ?? 9);
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / page_size));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * page_size;
  const pageRows = filtered.slice(start, start + page_size);

  /* ---------------- KPI（服务端算） ---------------- */
  const countBy = (level) => filtered.filter((row) => row.risk_level === level).length;
  const finiteCovers = filtered.map((row) => row.cover_days).filter((v) => Number.isFinite(v));
  const kpi = {
    row_count: total,
    stockout_count: countBy('缺货'),
    urgent_count: countBy('紧急'),
    suggest_count: countBy('建议'),
    slow_moving_count: countBy('滞销'),
    sufficient_count: countBy('充足'),
    low_stock_alert_count: filtered.filter((row) => row.guard?.alert === true).length,
    stale_count: filtered.filter((row) => row.flags.includes('stale_data')).length,
    total_suggest_num: roundTo(
      filtered.reduce((sum, row) => sum + (row.suggest_num || 0), 0),
      2,
    ),
    total_amount: roundTo(
      filtered.reduce((sum, row) => sum + (row.amount || 0), 0),
      2,
    ),
    inventory_capital: roundTo(
      filtered.reduce((sum, row) => sum + (row.inventory_capital || 0), 0),
      2,
    ),
    avg_cover_days: finiteCovers.length
      ? roundTo(finiteCovers.reduce((sum, v) => sum + v, 0) / finiteCovers.length, 2)
      : null,
    stockout_within_7d_count: filtered.filter(
      (row) => row.cover_days !== null && Number.isFinite(row.cover_days) && row.cover_days <= 7,
    ).length,
  };

  const assumptionIds = ['H1', 'H2', 'H4', 'H10'];
  const assumptions = ASSUMPTIONS.filter((item) => assumptionIds.includes(item.id));

  return {
    as_of: asOf,
    expected_arrival: addDays(asOf, Math.max(1, Math.round(plan.config.purchase_cycle_days))),
    plan: {
      plan_id: plan.plan_id,
      plan_name: plan.plan_name,
      plan_type: plan.plan_type,
      formula_text: formulaText(plan),
      provenance: plan.provenance ?? 'documented',
      config: plan.config,
    },
    risk_strategy: strategy,
    risk_levels: RISK_LEVEL_LIST,
    rows: pageRows,
    kpi,
    total,
    page: current,
    page_size,
    total_pages: totalPages,
    skipped,
    sort: { key: sortKey, order },
    /** 页面级可信声明：数量口径 documented，风险分级 enhancement */
    citation: {
      quantity_provenance: plan.provenance ?? 'documented',
      decision_provenance: 'enhancement',
      disclaimer:
        '本页「建议数量」严格来自官方文档口径（三个方案之一）；「风险分级 / 可售天数 / 预计断货日 / 库存资金」为演示用增强指标，无官方文档依据，阈值可在方案里调整。',
    },
    assumptions,
  };
}

/** 单个 SKU 的决策视图（供 SKU 详情页复用同一套风险口径） */
export function buildSkuDecision(db, skuCode, { asOf, plan_id, strategy: strategyOverride } = {}) {
  const plan = pickPlan(db, plan_id);
  const date = asOf ? String(asOf) : getSeedDate(db);
  const sku = getSkuByCode(db, skuCode);
  if (!sku) return null;
  const safetyConfig = getSafetyConfig(db);
  const holidays = getHolidayDates(db);
  const salesFrom = addDays(date, -Math.max(AVG_SALES_WINDOW, 120));
  const input = {
    plan,
    sku,
    inventory: getInventory(db, sku.id),
    sales: getSales(db, sku.id, { from: salesFrom, to: date }),
    safetyConfig,
    holidays,
    asOf: date,
  };
  const suggestion =
    plan.plan_type === PLAN_TYPES.SIGMA ? computeSigmaSuggestion(input) : computeDocumentedSuggestion(input);
  const risk = classifyRisk({
    asOf: date,
    sellable: suggestion.sellable_stock,
    in_transit: suggestion.in_transit_stock,
    avg_daily_exact: suggestion.avg_daily_sales_exact,
    suggest_num: suggestion.suggest_num,
    guard_alert: suggestion.guard?.alert === true,
    stale: (suggestion.flags ?? []).includes('stale_data'),
    strategy: { ...DEFAULT_RISK_STRATEGY, ...(strategyOverride ?? {}) },
  });
  return { as_of: date, plan, suggestion, risk };
}
