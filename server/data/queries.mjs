/**
 * queries.mjs — 读模型（把仓储 + 域层拼成"页面/工具"需要的数据形状）
 * ---------------------------------------------------------------------------
 * 为什么单独一层：HTTP 路由与 Agent 工具都需要「按方案批量算建议」，
 * 但两者都不该自己拼业务。这里只做三件事：取数 → 调域层 → 组装 KPI/分页。
 * 所有 KPI 在服务端算（前端禁止用当前页数据聚合）。
 */
import { addDays } from '../domain/dates.mjs';
import { DomainError, toErrorEnvelope } from '../domain/errors.mjs';
import { AVG_SALES_WINDOW, PLAN_TYPES, formulaText } from '../domain/plans.mjs';
import {
  computeDocumentedSuggestion,
  computeSigmaSuggestion,
  explainSuggestion,
  summarize,
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

function validatePage({ page, page_size }) {
  const p = Math.max(1, Math.trunc(Number(page) || 1));
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(page_size) || 20)));
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

/**
 * 批量算建议（页面与工具共用）
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{plan_id?:any, store_id?:any, category?:string, keyword?:string, as_of?:string,
 *          expected_arrival?:string, only_low?:any, page?:any, page_size?:any,
 *          scope?:'store'|'headquarters', gate_policy?:string, freshness_days?:number}} q
 */
export function buildSuggestions(db, q = {}) {
  const plan = pickPlan(db, q.plan_id);
  const asOf = q.as_of ? String(q.as_of) : getSeedDate(db);
  const { page, page_size } = validatePage(q);
  const safetyConfig = getSafetyConfig(db);
  const holidays = getHolidayDates(db);
  const scope = q.scope === 'headquarters' ? 'headquarters' : 'store';
  const onlyLow = q.only_low === undefined ? false : q.only_low === true || q.only_low === 1 || q.only_low === '1' || q.only_low === 'true';
  const expectedArrival = q.expected_arrival ? String(q.expected_arrival) : undefined;

  const skus = listSkus(db, { store_id: q.store_id, category: q.category, keyword: q.keyword });
  const salesFrom = addDays(asOf, -Math.max(AVG_SALES_WINDOW, 120));

  const rows = [];
  const skipped = [];
  for (const sku of skus) {
    try {
      const inventory = getInventory(db, sku.id);
      const sales = getSales(db, sku.id, { from: salesFrom, to: asOf });
      const input = {
        plan,
        sku,
        inventory,
        sales,
        safetyConfig,
        holidays,
        asOf,
        expectedArrival,
        scope,
        gatePolicy: q.gate_policy,
        freshness_days: q.freshness_days,
      };
      const row =
        plan.plan_type === PLAN_TYPES.SIGMA
          ? computeSigmaSuggestion(input)
          : computeDocumentedSuggestion(input);
      if (onlyLow && !row.guard.alert) continue;
      rows.push(row);
    } catch (err) {
      const env = toErrorEnvelope(err);
      skipped.push({ sku_code: sku.code, product_name: sku.name, code: env.code, message: env.message });
    }
  }

  // 排序：待补货优先 → 建议数量降序 → 金额降序
  rows.sort((a, b) => {
    const pa = a.suggest_num > 0 ? 0 : 1;
    const pb = b.suggest_num > 0 ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (b.suggest_num !== a.suggest_num) return b.suggest_num - a.suggest_num;
    return (b.amount ?? 0) - (a.amount ?? 0);
  });

  const kpi = summarize(rows);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / page_size));
  const start = (Math.min(page, totalPages) - 1) * page_size;
  const pageRows = rows.slice(start, start + page_size);

  return {
    as_of: asOf,
    expected_arrival: expectedArrival ?? addDays(asOf, Math.max(1, Math.round(plan.config.purchase_cycle_days))),
    plan: {
      plan_id: plan.plan_id,
      plan_name: plan.plan_name,
      plan_type: plan.plan_type,
      config: plan.config,
      provenance: plan.provenance,
      formula_text: plan.formula_text ?? formulaText(plan.config),
    },
    formula_text: plan.formula_text ?? formulaText(plan.config),
    scope,
    rows: pageRows,
    kpi,
    skipped,
    total,
    page: Math.min(page, totalPages),
    page_size,
    total_pages: totalPages,
    guard_note:
      '补货建议只在商品处于「低库存预警」时生成：实物库存 + 在途库存 < 库存预警下限（口径可切换，见假设 H4）。' +
      '日均销量按近 15 个自然日计算，缺日补零（假设 H2/H7）；建议数量向上取整（假设 H1）。',
  };
}

/**
 * SKU 详情（解释下钻：四层下钻的第一层=事实，第二层=趋势，第三层=方案对照，第四层=参数来源）
 */
export function getSkuDetail(db, skuCode, { as_of, expected_arrival, scope = 'store' } = {}) {
  const sku = getSkuByCode(db, skuCode);
  if (!sku) throw new DomainError('NOT_FOUND', `SKU ${skuCode} 不存在`);
  const asOf = as_of ? String(as_of) : getSeedDate(db);
  const safetyConfig = getSafetyConfig(db);
  const holidays = getHolidayDates(db);
  const inventory = getInventory(db, sku.id);
  const salesFrom = addDays(asOf, -90);
  const salesRows = getSales(db, sku.id, { from: salesFrom, to: asOf });

  const plans = listPlans(db);
  const suggestions = [];
  const errors = [];
  for (const plan of plans) {
    try {
      const input = { plan, sku, inventory, sales: salesRows, safetyConfig, holidays, asOf, expectedArrival: expected_arrival, scope };
      const row = plan.plan_type === PLAN_TYPES.SIGMA ? computeSigmaSuggestion(input) : computeDocumentedSuggestion(input);
      suggestions.push(row);
    } catch (err) {
      const env = toErrorEnvelope(err);
      errors.push({ plan_id: plan.plan_id, code: env.code, message: env.message });
    }
  }

  // 90 天稠密序列（给曲线用；缺日记 0）
  const series = [];
  for (let i = 89; i >= 0; i--) {
    const date = addDays(asOf, -i);
    const qty = salesRows
      .filter((r) => r.date === date)
      .reduce((a, b) => a + Number(b.qty || 0), 0);
    series.push({ date, qty });
  }

  const documented = suggestions.find((s) => s.provenance === 'documented') ?? suggestions[0] ?? null;

  return {
    sku: {
      sku_id: sku.id,
      sku_code: sku.code,
      sku_no: sku.sku_no,
      product_name: sku.name,
      spec: sku.spec,
      unit: sku.unit,
      category: sku.category,
      store_id: sku.store_id,
      store_name: sku.store_name,
      supplier_code: sku.supplier_code,
      supplier_name: sku.supplier_name,
      cost_price: sku.cost_price,
      retail_price: sku.retail_price,
      tax_rate: sku.tax_rate,
      status: sku.status,
    },
    inventory,
    series,
    sales_rows: salesRows,
    suggestions,
    errors,
    explain: documented ? explainSuggestion(documented) : null,
    as_of: asOf,
  };
}

/** 某方案的完整建议（不分页，供 Agent/导出使用；带上限保护） */
export function buildAllSuggestions(db, q = {}) {
  return buildSuggestions(db, { ...q, page: 1, page_size: MAX_PAGE_SIZE });
}
