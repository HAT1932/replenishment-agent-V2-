/**
 * suggestion.mjs — 补货建议主计算（文档口径三方案 + 增强 σ 方案）
 * ---------------------------------------------------------------------------
 * 本文件是「唯一算法出口」。纪律：
 *   1) 全程 exact 浮点，`ceilInt` 只在落地时调用一次（修 v1 的 D2）；
 *   2) 一切时间由 `asOf` 显式传入（修 v1 的隐式时钟）；
 *   3) 每个结论都回带 provenance + assumptions + 可审计的 terms/guard；
 *   4) 方案 2 用实物库存、方案 1 用可售库存、方案 3 用可售+在途 —— 与官方公式逐字对齐。
 */
import { coverageCoefficient } from './calendar.mjs';
import { addDays, assertDate, diffDays } from './dates.mjs';
import { demandSigmaDaily, demandWindow, forecastDemand } from './demand.mjs';
import { validationError } from './errors.mjs';
import { inventorySnapshot } from './inventory.mjs';
import { ceilInt, ceilToPack, daysOfCover, reorderPoint, roundTo, safetyStock, sigmaOverLeadTime, turnoverRate } from './math.mjs';
import { AVG_SALES_WINDOW, PLAN_TYPES, PROVENANCE, formulaText, resolvePlanConfig } from './plans.mjs';
import { evaluateLowStockGate, resolveSafetyStock } from './safety.mjs';

const DEFAULT_FRESHNESS_DAYS = 1;

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

function resolveArrival({ asOf, plan, expectedArrival }) {
  if (expectedArrival) {
    assertDate(expectedArrival, 'expectedArrival');
    if (diffDays(asOf, expectedArrival) < 0) {
      throw validationError(`预计到货日 ${expectedArrival} 早于数据日期 ${asOf}`);
    }
    return expectedArrival;
  }
  // 默认：今天 + 采购周期（文档未定义默认值，属工程选择；方案 3 才真正用到）
  return addDays(asOf, Math.max(1, Math.round(plan.purchase_cycle_days)));
}

function buildCoefficient({ plan, arrival, holidays }) {
  if (!plan.coefficient_enabled) {
    return {
      coefficient_exact: 1,
      coefficient: 1,
      days: 0,
      total_exact: 0,
      window: null,
      series: [],
      assumptions: [],
      enabled: false,
    };
  }
  const coef = coverageCoefficient({
    arrivalDate: arrival,
    cycleDays: plan.purchase_cycle_days,
    weekend: { enabled: plan.weekend_coefficient_enabled, coefficient: plan.weekend_coefficient },
    holiday: { enabled: plan.holiday_coefficient_enabled, coefficient: plan.holiday_coefficient },
    holidays,
  });
  return { ...coef, enabled: true };
}

/**
 * 文档口径三方案之一：算一条补货建议
 * @param {{
 *   plan: object, sku: object, inventory: object,
 *   sales: Array<{date:string,qty:number,outbound_type?:string}>,
 *   safetyConfig?: object, holidays?: string[]|Set<string>,
 *   asOf: string, expectedArrival?: string,
 *   applyNumOverride?: number, scope?: 'store'|'headquarters',
 *   gatePolicy?: string, freshness_days?: number
 * }} input
 */
export function computeDocumentedSuggestion(input) {
  const {
    plan: rawPlan,
    sku,
    inventory,
    sales = [],
    safetyConfig,
    holidays,
    asOf,
    expectedArrival,
    applyNumOverride,
    scope = 'store',
    gatePolicy,
    freshness_days = DEFAULT_FRESHNESS_DAYS,
  } = input ?? {};

  assertDate(asOf, 'asOf');
  if (!sku) throw validationError('sku 必填');
  if (!sku.code && !sku.sku_code) throw validationError('sku.code 必填');

  // 兼容两种入参：方案装饰对象 {plan_id, plan_name, plan_type, config} 或裸配置对象。
  // 注意：装饰对象里真正参与计算的参数在 `config` 下，必须解开——否则 coefficient_enabled 等参数会静默回落到默认值。
  const planFromRepo =
    rawPlan && typeof rawPlan.config === 'object' && rawPlan.config !== null
      ? { ...rawPlan.config, plan_type: rawPlan.plan_type ?? rawPlan.config.plan_type }
      : { ...(rawPlan ?? {}) };
  const plan = resolvePlanConfig(planFromRepo);
  const planType = plan.plan_type;
  if (planType === PLAN_TYPES.SIGMA) {
    throw validationError('σ 方案请使用 computeSigmaSuggestion()，不要走文档口径入口');
  }

  const inv = inventorySnapshot(inventory, { asOf, freshness_days });
  const window = demandWindow({ sales, asOf, days: AVG_SALES_WINDOW, scope, freshness_days });
  const avgExact = window.avg_daily_exact;

  const safety = resolveSafetyStock({ config: safetyConfig, avg_daily_exact: avgExact });
  const gate = evaluateLowStockGate({
    stock_num: inv.on_hand,
    in_transit: inv.in_transit,
    stock_lower: safety.lower,
    policy: gatePolicy,
  });

  const arrival = resolveArrival({ asOf, plan, expectedArrival });
  const coef = buildCoefficient({ plan, arrival, holidays });

  /** @type {Record<string, number>} */
  const terms = {};
  let rawExact;
  let formulaExpr;

  if (planType === PLAN_TYPES.STOCK_UPPER) {
    // 方案 2：库存上限 − 当前实物库存（H6：不减占用/在途）
    terms.stock_upper_exact = safety.upper_exact;
    terms.on_hand = inv.on_hand;
    rawExact = safety.upper_exact - inv.on_hand;
    formulaExpr = `${roundTo(safety.upper_exact, 4)} − ${inv.on_hand}`;
  } else if (planType === PLAN_TYPES.CUSTOM) {
    // 方案 3：(日均 × 采购周期 + 下限 − 可售 − 在途) × 综合系数
    terms.avg_daily_sales_exact = avgExact;
    terms.purchase_cycle_days = plan.purchase_cycle_days;
    terms.stock_lower_exact = safety.lower_exact;
    terms.sellable_exact = inv.sellable_exact;
    terms.in_transit_exact = inv.in_transit;
    terms.coefficient_exact = coef.coefficient_exact;
    rawExact =
      (avgExact * plan.purchase_cycle_days + safety.lower_exact - inv.sellable_exact - inv.in_transit) *
      coef.coefficient_exact;
    formulaExpr =
      `(${roundTo(avgExact, 4)} × ${plan.purchase_cycle_days} + ${roundTo(safety.lower_exact, 4)} ` +
      `− ${roundTo(inv.sellable_exact, 4)} − ${inv.in_transit}) × ${roundTo(coef.coefficient_exact, 6)}`;
  } else {
    // 方案 1（默认）：日均 × 可售天数 + 下限 − 可售库存
    terms.avg_daily_sales_exact = avgExact;
    terms.coverage_days = plan.coverage_days;
    terms.stock_lower_exact = safety.lower_exact;
    terms.sellable_exact = inv.sellable_exact;
    rawExact = avgExact * plan.coverage_days + safety.lower_exact - inv.sellable_exact;
    formulaExpr = `${roundTo(avgExact, 4)} × ${plan.coverage_days} + ${roundTo(safety.lower_exact, 4)} − ${roundTo(inv.sellable_exact, 4)}`;
  }

  const rawPositive = Math.max(0, rawExact);
  // 闸门：只有低库存预警且公式值为正才产出建议
  const suggestNum = gate.alert && rawPositive > 0 ? ceilInt(rawPositive) : 0;
  const overrideUsed = applyNumOverride !== undefined && applyNumOverride !== null && applyNumOverride !== '';
  let applyNum = suggestNum;
  if (overrideUsed) {
    const n = Number(applyNumOverride);
    if (!Number.isFinite(n) || n < 0) throw validationError(`采购数量覆盖值非法：${applyNumOverride}`);
    if (Math.abs(n - Math.round(n)) > 1e-9) throw validationError(`采购数量必须为整数件，收到 ${n}`);
    applyNum = Math.round(n);
    // 人工覆盖是**人的决定**：闸门关闭时也允许（例如主动备货），但必须可审计
  }

  const unitCost = Number(sku.cost_price) || 0;
  const taxRate = Number(sku.tax_rate) || 0;
  const amount = roundTo(applyNum * unitCost, 2);
  const taxAmount = roundTo(amount * taxRate, 2);

  const flags = uniq([
    window.status === 'stale' || inv.status === 'stale' ? 'stale_data' : null,
    inv.sellable_exact < 0 ? 'negative_sellable' : null,
    overrideUsed ? 'override' : null,
    !gate.alert && rawPositive > 0 ? 'gate_closed' : null,
    !overrideUsed && gate.alert && rawPositive > 0 && suggestNum === 0 ? 'rounding_zero' : null,
  ]);

  const assumptions = uniq([
    'H1', // ceil
    'H2', // 15 自然日
    'H4', // 闸门口径
    'H7', // 含零销量日
    planType === PLAN_TYPES.CUSTOM && coef.enabled ? 'H3' : null,
    safety.mode === 'dynamic' ? 'H5' : null,
    planType === PLAN_TYPES.STOCK_UPPER ? 'H6' : null,
    'H8', // ≤0 不展示
  ]);

  const suggestion = {
    /* 标识 */
    sku_id: sku.id ?? sku.sku_id ?? null,
    store_id: sku.store_id ?? null,
    store_name: sku.store_name ?? '',
    warehouse_code: sku.warehouse_code ?? '',
    sku_code: sku.code ?? sku.sku_code,
    sku_no: sku.sku_no ?? '',
    product_name: sku.name ?? sku.product_name ?? '',
    spec: sku.spec ?? '',
    unit: sku.unit ?? '',
    category: sku.category ?? '',
    supplier_code: sku.supplier_code ?? '',
    supplier_name: sku.supplier_name ?? '',

    /* 表格列（官方 9 列同序同义） */
    stock_upper: safety.upper,
    stock_lower: safety.lower,
    avg_daily_sales: roundTo(avgExact, 4),
    sellable_stock: inv.sellable_exact,
    in_transit_stock: inv.in_transit,
    suggest_num: suggestNum,
    apply_num: applyNum,

    /* 计算事实 */
    avg_daily_sales_exact: avgExact,
    suggest_raw_exact: rawPositive,
    suggest_raw: roundTo(rawPositive, 4),
    formula_expr: formulaExpr,
    terms,
    guard: gate,
    coefficient_exact: coef.coefficient_exact,
    coefficient: roundTo(coef.coefficient_exact, 6),
    coefficient_detail: coef.series,
    coefficient_enabled: Boolean(coef.enabled),
    coefficient_window: coef.window,

    /* 需求窗口 */
    demand_window: {
      as_of: window.asOf,
      days: window.days,
      scope: window.scope,
      include: window.include,
      total: window.total,
      recorded_days: window.recorded_days,
      imputed_days: window.imputed_days,
      last_recorded_date: window.last_recorded_date,
      staleness_days: window.staleness_days,
      status: window.status,
      series: window.points,
    },
    inventory: {
      on_hand: inv.on_hand,
      locked: inv.locked,
      sellable: inv.sellable_exact,
      in_transit: inv.in_transit,
      plan_stock: inv.plan_stock,
      snapshot_date: inv.snapshot_date,
      staleness_days: inv.staleness_days,
      status: inv.status,
    },

    /* 方案与溯源 */
    plan_id: rawPlan?.plan_id ?? null,
    plan_name: rawPlan?.plan_name ?? '',
    plan_type: planType,
    plan_type_label: planType,
    formula_text: formulaText(plan),
    provenance: PROVENANCE[planType] ?? 'documented',
    assumptions,
    flags,

    /* 时间 */
    as_of: asOf,
    expected_arrival: arrival,

    /* 金额 */
    unit_cost: unitCost,
    tax_rate: taxRate,
    amount,
    tax_amount: taxAmount,
  };

  /** 逐项归因（供 suggestion.explain / 前端解释抽屉） */
  suggestion.why = buildWhy({ suggestion, plan, coef, gate, safety, window, inv });
  return suggestion;
}

function buildWhy({ suggestion, plan, coef, gate, safety, window, inv }) {
  const steps = [
    {
      step: '需求窗口',
      expr: `近 ${window.days} 个自然日（${window.asOf} 止，口径 ${window.include.join('+')}）`,
      value: `${window.total} 件 / ${window.days} 天 = ${roundTo(window.avg_daily_exact ?? 0, 4)} 件/天`,
      note:
        window.imputed_days > 0
          ? `其中 ${window.imputed_days} 天无出库记录按 0 计（缺日补零）；最近记录 ${window.last_recorded_date ?? '无'}`
          : `全部 ${window.days} 天均有出库记录`,
    },
    {
      step: '库存口径',
      expr: `实物 ${inv.on_hand} − 占用 ${inv.locked} = 可售 ${roundTo(inv.sellable_exact, 4)}；在途 ${inv.in_transit}`,
      value: `可售 ${roundTo(inv.sellable_exact, 4)}`,
      note: inv.sellable_exact < 0 ? '可售为负（超卖/占用大于实物），公式按原值代入' : '',
    },
    {
      step: '库存预警',
      expr: safety.formula_text,
      value: `下限 ${safety.lower} / 上限 ${safety.upper}`,
      note: safety.mode === 'dynamic' ? '动态值 = 可售天数 × 日均销量（向上取整，H5）' : '固定值',
    },
    {
      step: '低库存闸门',
      expr: gate.text,
      value: gate.alert ? '通过（低库存预警）' : '不通过（不产出建议）',
      note: `口径 ${gate.policy}（H4：两篇官方文档对低预警定义不一致）`,
    },
  ];
  if (coef.enabled) {
    steps.push({
      step: '综合系数',
      expr: `窗口 ${coef.window.start} ~ ${coef.window.end}（${coef.days} 天）Σ=${roundTo(coef.total_exact, 6)}`,
      value: `${roundTo(coef.coefficient_exact, 6)}`,
      note: `逐日：${coef.series.map((s) => `${s.date.slice(5)}×${s.factor}`).join(' ')}`,
    });
  }
  steps.push({
    step: '公式',
    expr: suggestion.formula_expr,
    value: `raw = ${roundTo(suggestion.suggest_raw_exact, 6)}`,
    note: `向上取整 → 建议数量 ${suggestion.suggest_num}（H1）`,
  });
  return steps;
}

/**
 * 增强 σ 方案（provenance=enhancement）：目标库存法 + 装箱/MOQ
 */
export function computeSigmaSuggestion(input) {
  const {
    plan: rawPlan,
    sku,
    inventory,
    sales = [],
    safetyConfig,
    holidays,
    asOf,
    expectedArrival,
    applyNumOverride,
    scope = 'store',
    gatePolicy,
    freshness_days = DEFAULT_FRESHNESS_DAYS,
  } = input ?? {};

  assertDate(asOf, 'asOf');
  // σ 方案同样要解开装饰对象（否则 lead_time_days / pack_size 等会静默回落默认值）
  const sigmaPlanFromRepo =
    rawPlan && typeof rawPlan.config === 'object' && rawPlan.config !== null
      ? { ...rawPlan.config }
      : { ...(rawPlan ?? {}) };
  const plan = resolvePlanConfig({ ...sigmaPlanFromRepo, plan_type: PLAN_TYPES.SIGMA });
  const inv = inventorySnapshot(inventory, { asOf, freshness_days });
  const window = demandWindow({ sales, asOf, days: AVG_SALES_WINDOW, scope, freshness_days });
  const safety = resolveSafetyStock({ config: safetyConfig, avg_daily_exact: window.avg_daily_exact });
  const gate = evaluateLowStockGate({
    stock_num: inv.on_hand,
    in_transit: inv.in_transit,
    stock_lower: safety.lower,
    policy: gatePolicy,
  });

  const forecast = forecastDemand({ sales, asOf, params: plan, scope });
  const sigma = demandSigmaDaily({ sales, asOf, params: plan, scope });
  const sigmaLt = sigmaOverLeadTime(sigma.sigma_daily_exact, plan.lead_time_days);
  const ss = safetyStock({
    sigma_lead_time: sigmaLt,
    forecast_daily: forecast.forecast_daily_exact,
    service_level: plan.service_level,
    safety_days: plan.safety_days,
  });
  const target = forecast.forecast_daily_exact * (plan.coverage_days + plan.lead_time_days) + ss.safety_stock;
  const rawExact = Math.max(0, target - inv.sellable_exact - inv.in_transit);
  const suggestNum = gate.alert && rawExact > 0 ? ceilToPack(rawExact, plan.pack_size, plan.moq) : 0;
  const overrideUsed = applyNumOverride !== undefined && applyNumOverride !== null && applyNumOverride !== '';
  let applyNum = suggestNum;
  if (overrideUsed) {
    const n = Number(applyNumOverride);
    if (!Number.isFinite(n) || n < 0) throw validationError(`采购数量覆盖值非法：${applyNumOverride}`);
    applyNum = Math.round(n);
  }

  const cover = daysOfCover(inv.sellable_exact, forecast.forecast_daily_exact);
  const arrival = resolveArrival({ asOf, plan, expectedArrival });
  const unitCost = Number(sku.cost_price) || 0;
  const taxRate = Number(sku.tax_rate) || 0;
  const amount = roundTo(applyNum * unitCost, 2);

  const assumptions = uniq([
    'H1',
    'H2',
    'H4',
    'H7',
    'H8',
    'H10',
    safety.mode === 'dynamic' ? 'H5' : null,
  ]);

  return {
    sku_id: sku.id ?? sku.sku_id ?? null,
    store_id: sku.store_id ?? null,
    store_name: sku.store_name ?? '',
    warehouse_code: sku.warehouse_code ?? '',
    sku_code: sku.code ?? sku.sku_code,
    sku_no: sku.sku_no ?? '',
    product_name: sku.name ?? sku.product_name ?? '',
    spec: sku.spec ?? '',
    unit: sku.unit ?? '',
    category: sku.category ?? '',
    supplier_code: sku.supplier_code ?? '',
    supplier_name: sku.supplier_name ?? '',

    stock_upper: safety.upper,
    stock_lower: safety.lower,
    avg_daily_sales: roundTo(window.avg_daily_exact, 4),
    sellable_stock: inv.sellable_exact,
    in_transit_stock: inv.in_transit,
    suggest_num: suggestNum,
    apply_num: applyNum,

    avg_daily_sales_exact: window.avg_daily_exact,
    suggest_raw_exact: rawExact,
    suggest_raw: roundTo(rawExact, 4),
    formula_expr: `目标库存 ${roundTo(target, 4)} − 可售 ${roundTo(inv.sellable_exact, 4)} − 在途 ${inv.in_transit}`,
    terms: {
      forecast_daily_exact: forecast.forecast_daily_exact,
      coverage_days: plan.coverage_days,
      lead_time_days: plan.lead_time_days,
      safety_stock: ss.safety_stock,
      target_stock_exact: target,
      sellable_exact: inv.sellable_exact,
      in_transit_exact: inv.in_transit,
      pack_size: plan.pack_size,
      moq: plan.moq,
    },
    guard: gate,
    coefficient_exact: 1,
    coefficient: 1,
    coefficient_detail: [],
    coefficient_enabled: false,
    coefficient_window: null,
    demand_window: {
      as_of: window.asOf,
      days: window.days,
      scope: window.scope,
      include: window.include,
      total: window.total,
      recorded_days: window.recorded_days,
      imputed_days: window.imputed_days,
      last_recorded_date: window.last_recorded_date,
      staleness_days: window.staleness_days,
      status: window.status,
      series: window.points,
    },
    inventory: {
      on_hand: inv.on_hand,
      locked: inv.locked,
      sellable: inv.sellable_exact,
      in_transit: inv.in_transit,
      plan_stock: inv.plan_stock,
      snapshot_date: inv.snapshot_date,
      staleness_days: inv.staleness_days,
      status: inv.status,
    },

    plan_id: rawPlan?.plan_id ?? null,
    plan_name: rawPlan?.plan_name ?? '',
    plan_type: PLAN_TYPES.SIGMA,
    plan_type_label: PLAN_TYPES.SIGMA,
    formula_text: formulaText(plan),
    provenance: PROVENANCE.sigma,
    assumptions,
    flags: uniq([
      window.status === 'stale' || inv.status === 'stale' ? 'stale_data' : null,
      inv.sellable_exact < 0 ? 'negative_sellable' : null,
      overrideUsed ? 'override' : null,
      !gate.alert && rawExact > 0 ? 'gate_closed' : null,
    ]),

    as_of: asOf,
    expected_arrival: arrival,

    /* 增强字段 */
    forecast_daily: roundTo(forecast.forecast_daily_exact, 4),
    sigma_daily: roundTo(sigma.sigma_daily_exact, 4),
    sigma_lead_time: roundTo(sigmaLt, 4),
    safety_stock: ss.safety_stock,
    safety_method: ss.method,
    z: ss.z,
    target_stock: roundTo(target, 4),
    reorder_point: reorderPoint(forecast.forecast_daily_exact, plan.lead_time_days, ss.safety_stock),
    days_of_cover: Number.isFinite(cover) ? roundTo(cover, 2) : null,
    turnover_rate: turnoverRate(window.avg_daily_exact, inv.sellable_exact),
    stockout_date: Number.isFinite(cover) ? addDays(asOf, Math.floor(cover)) : null,

    unit_cost: unitCost,
    tax_rate: taxRate,
    amount,
    tax_amount: roundTo(amount * taxRate, 2),
  };
}

/** 统一入口：按 plan.plan_type 分派 */
export function computeSuggestion(input) {
  const planType = input?.plan?.plan_type ?? input?.plan_type;
  return planType === PLAN_TYPES.SIGMA ? computeSigmaSuggestion(input) : computeDocumentedSuggestion(input);
}

/** 汇总 KPI（一律服务端算，禁止前端用当前页数据聚合） */
export function summarize(rows) {
  const list = rows ?? [];
  let totalQty = 0;
  let totalAmount = 0;
  let totalTax = 0;
  let avgSum = 0;
  let pending = 0;
  let lowStockAlert = 0;
  let stale = 0;
  let negative = 0;
  let withCoefficient = 0;
  for (const r of list) {
    totalQty += r.apply_num || 0;
    totalAmount += r.amount || 0;
    totalTax += r.tax_amount || 0;
    avgSum += r.avg_daily_sales_exact ?? r.avg_daily_sales ?? 0;
    if (r.suggest_num > 0) pending += 1;
    if (r.guard?.alert) lowStockAlert += 1;
    if (r.flags?.includes('stale_data')) stale += 1;
    if (r.flags?.includes('negative_sellable')) negative += 1;
    if (r.coefficient_enabled) withCoefficient += 1;
  }
  const n = list.length;
  const canonical = {
    row_count: n,
    pending_count: pending,
    low_stock_alert_count: lowStockAlert,
    stale_count: stale,
    negative_sellable_count: negative,
    coefficient_row_count: withCoefficient,
    total_suggest_qty: roundTo(totalQty, 2),
    total_amount: roundTo(totalAmount, 2),
  };
  // 前端契约（SuggestionsKpi）用另一组命名；服务端同时给别名，避免前端改名或漏显
  return {
    ...canonical,
    /** 前端「建议 SKU 数」= 真正有待补数量的 SKU 数（非总行数） */
    suggest_sku_count: canonical.pending_count,
    low_stock_count: canonical.low_stock_alert_count,
    stale_sku_count: canonical.stale_count,
    total_suggest_num: canonical.total_suggest_qty,
    total_apply_num: canonical.total_suggest_qty,
    total_qty: canonical.total_suggest_qty,
    suggest_amount: canonical.total_amount,
    tax_amount: roundTo(totalTax, 2),
    avg_daily_sales: n ? roundTo(avgSum / n, 4) : 0,
  };
}

/** 解释（供 suggestion.explain 工具；不重新计算，只投影已有事实） */
export function explainSuggestion(suggestion) {
  if (!suggestion) throw validationError('suggestion 必填');
  return {
    sku_code: suggestion.sku_code,
    plan_type: suggestion.plan_type,
    provenance: suggestion.provenance,
    formula_text: suggestion.formula_text,
    formula_expr: suggestion.formula_expr,
    terms: suggestion.terms,
    guard: suggestion.guard,
    coefficient: {
      enabled: suggestion.coefficient_enabled,
      value: suggestion.coefficient,
      window: suggestion.coefficient_window,
      detail: suggestion.coefficient_detail,
    },
    demand_window: suggestion.demand_window,
    suggest_raw_exact: suggestion.suggest_raw_exact,
    suggest_num: suggestion.suggest_num,
    rounding: '向上取整 ceil（H1）',
    assumptions: suggestion.assumptions,
    steps: suggestion.why ?? [],
  };
}
