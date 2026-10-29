import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDocumentedSuggestion,
  computeSuggestion,
  computeSigmaSuggestion,
  explainSuggestion,
  summarize,
  PLAN_TYPES,
} from '../../server/domain/index.mjs';

const AS_OF = '2026-10-29';
const dates = (n, end = AS_OF) => {
  const out = [];
  const dt = new Date(`${end}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(dt);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};
/** 15 天总量 total 的销量序列（全部落在最后一天，避免星期因子干扰） */
const salesOfTotal = (total, end = AS_OF) =>
  dates(15, end).map((date, i) => ({ date, qty: i === 14 ? total : 0 }));

const sku = {
  id: 1,
  store_id: 1,
  store_name: '上海静安嘉里中心店',
  code: 'SP001',
  sku_no: 'SH001-00001',
  name: '农夫山泉饮用水',
  spec: '550ml*24瓶/箱',
  unit: '箱',
  category: '饮料',
  cost_price: 22,
  tax_rate: 0.13,
  supplier_code: 'GYS003',
  supplier_name: '农夫山泉上海仓',
};

const safetyFixed = { mode: 'fixed', lower_fixed: 10, upper_fixed: 100 };

test('方案1：近15天日均 × 可售天数 + 下限 − 可售库存，向上取整', () => {
  const r = computeDocumentedSuggestion({
    plan: { plan_type: PLAN_TYPES.AVG_DAILY, coverage_days: 15, purchase_cycle_days: 7 },
    sku,
    inventory: { on_hand: 0, locked: 0, in_transit: 0, snapshot_date: AS_OF },
    sales: salesOfTotal(10),
    safetyConfig: safetyFixed,
    asOf: AS_OF,
  });
  // 10/15=0.6667 × 15 = 10；+10 −0 = 20
  assert.equal(r.avg_daily_sales_exact, 10 / 15);
  assert.equal(r.stock_lower, 10);
  assert.equal(r.suggest_raw_exact, 20);
  assert.equal(r.suggest_num, 20);
  assert.equal(r.provenance, 'documented');
  assert.equal(r.apply_num, 20);
  assert.equal(r.amount, 440);
  assert.equal(r.tax_amount, 57.2);
  assert.ok(r.assumptions.includes('H1'));
  assert.ok(r.assumptions.includes('H4'));
});

test('D2 回归：不得先舍入再乘天数（352 件/15 天 → 362，不是 363）', () => {
  const r = computeDocumentedSuggestion({
    plan: { plan_type: PLAN_TYPES.AVG_DAILY, coverage_days: 15 },
    sku,
    inventory: { on_hand: 0, locked: 0, in_transit: 0, snapshot_date: AS_OF },
    sales: salesOfTotal(352),
    safetyConfig: safetyFixed,
    asOf: AS_OF,
  });
  // exact: 352/15×15 + 10 = 362
  assert.equal(r.avg_daily_sales, 23.4667, '展示值仍为 4 位小数');
  assert.equal(r.avg_daily_sales_exact, 352 / 15);
  assert.ok(Math.abs(r.suggest_raw_exact - 362) < 1e-9, '运算必须用 exact');
  assert.equal(r.suggest_num, 362, 'v1 会输出 363（先 round4 再 ceil）');
  // 展示值不参与运算：用 display 值算会得到 363
  assert.notEqual(Math.ceil(23.4667 * 15 + 10), 362);
});

test('闸门：非低库存不产出建议（即使公式值为正）', () => {
  const r = computeDocumentedSuggestion({
    plan: { plan_type: PLAN_TYPES.AVG_DAILY, coverage_days: 15 },
    sku,
    // 实物 5 + 在途 100 = 105 ≥ 下限 10 → 闸门关闭；但公式值 = 10+10−0 = 20 > 0
    inventory: { on_hand: 5, locked: 5, in_transit: 100, snapshot_date: AS_OF },
    sales: salesOfTotal(10),
    safetyConfig: safetyFixed,
    asOf: AS_OF,
  });
  assert.equal(r.guard.alert, false);
  assert.ok(r.suggest_raw_exact > 0);
  assert.equal(r.suggest_num, 0);
  assert.ok(r.flags.includes('gate_closed'));
});

test('闸门边界：下限 0 时库存 0 不预警（FAQ 口径）', () => {
  const r = computeDocumentedSuggestion({
    plan: { plan_type: PLAN_TYPES.AVG_DAILY, coverage_days: 15 },
    sku,
    inventory: { on_hand: 0, locked: 0, in_transit: 0, snapshot_date: AS_OF },
    sales: salesOfTotal(0),
    safetyConfig: { mode: 'fixed', lower_fixed: 0, upper_fixed: 100 },
    asOf: AS_OF,
  });
  assert.equal(r.guard.alert, false);
  assert.equal(r.suggest_num, 0);
});

test('方案2：库存上限 − 当前实物库存', () => {
  const r = computeDocumentedSuggestion({
    plan: { plan_type: PLAN_TYPES.STOCK_UPPER },
    sku,
    inventory: { on_hand: 4, locked: 3, in_transit: 0, snapshot_date: AS_OF },
    sales: salesOfTotal(0),
    safetyConfig: safetyFixed,
    asOf: AS_OF,
  });
  assert.equal(r.suggest_raw_exact, 96, '上限 100 − 实物 4（不减占用）');
  assert.equal(r.suggest_num, 96);
  assert.ok(r.assumptions.includes('H6'));
});

test('方案3：含在途与综合系数', () => {
  const asOf = '2018-12-01';
  const r = computeDocumentedSuggestion({
    plan: {
      plan_type: PLAN_TYPES.CUSTOM,
      purchase_cycle_days: 5,
      coefficient_enabled: 1,
      weekend_coefficient_enabled: 1,
      weekend_coefficient: 1.1,
      holiday_coefficient_enabled: 1,
      holiday_coefficient: 1.2,
    },
    sku,
    inventory: { on_hand: 5, locked: 3, in_transit: 2, snapshot_date: asOf },
    sales: dates(15, asOf).map((date, i) => ({ date, qty: i === 14 ? 15 : 0 })), // 日均 1
    safetyConfig: { mode: 'fixed', lower_fixed: 10, upper_fixed: 100 },
    holidays: [],
    asOf,
    expectedArrival: '2018-12-05',
  });
  // 2018-12-05..09：1,1,1,1.1,1.1 → 5.2/5 = 1.04
  assert.equal(r.coefficient, 1.04);
  assert.equal(r.coefficient_detail.length, 5);
  // (1×5 + 10 − 2 − 2) × 1.04 = 11 × 1.04 = 11.44 → ceil 12
  assert.ok(Math.abs(r.suggest_raw_exact - 11.44) < 1e-9, `raw=${r.suggest_raw_exact}`);
  assert.equal(r.suggest_num, 12);
  assert.ok(r.assumptions.includes('H3'));
});

test('方案2 与方案3 的方案类型不会串台（plan_type 校验）', () => {
  assert.throws(
    () =>
      computeDocumentedSuggestion({
        plan: { plan_type: PLAN_TYPES.SIGMA },
        sku,
        inventory: { on_hand: 1, locked: 0, in_transit: 0, snapshot_date: AS_OF },
        sales: salesOfTotal(1),
        safetyConfig: safetyFixed,
        asOf: AS_OF,
      }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () =>
      computeDocumentedSuggestion({
        plan: { plan_type: 'whatever' },
        sku,
        inventory: { on_hand: 1, locked: 0, in_transit: 0, snapshot_date: AS_OF },
        sales: [],
        safetyConfig: safetyFixed,
        asOf: AS_OF,
      }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
});

test('人工覆盖采购数量：允许、标记 override、可绕过闸门但留痕', () => {
  const r = computeDocumentedSuggestion({
    plan: { plan_type: PLAN_TYPES.AVG_DAILY, coverage_days: 15 },
    sku,
    inventory: { on_hand: 100, locked: 0, in_transit: 0, snapshot_date: AS_OF },
    sales: salesOfTotal(10),
    safetyConfig: safetyFixed,
    asOf: AS_OF,
    applyNumOverride: 30,
  });
  assert.equal(r.guard.alert, false);
  assert.equal(r.suggest_num, 0);
  assert.equal(r.apply_num, 30, '人工决定优先');
  assert.ok(r.flags.includes('override'));
});

test('缺库存快照 → DATA_MISSING（v1 会当成 0 库存直接给出最大补货量）', () => {
  assert.throws(
    () =>
      computeDocumentedSuggestion({
        plan: { plan_type: PLAN_TYPES.AVG_DAILY },
        sku,
        inventory: null,
        sales: salesOfTotal(10),
        safetyConfig: safetyFixed,
        asOf: AS_OF,
      }),
    (e) => e.code === 'DATA_MISSING',
  );
});

test('数据过期 → stale_data 标记且公式仍可算（由上层决定是否自动下单）', () => {
  const oldSales = salesOfTotal(30, '2026-10-10');
  const r = computeDocumentedSuggestion({
    plan: { plan_type: PLAN_TYPES.AVG_DAILY, coverage_days: 15 },
    sku,
    inventory: { on_hand: 0, locked: 0, in_transit: 0, snapshot_date: '2026-10-20' },
    sales: oldSales,
    safetyConfig: safetyFixed,
    asOf: AS_OF,
    freshness_days: 1,
  });
  assert.ok(r.flags.includes('stale_data'));
  assert.equal(r.demand_window.status, 'stale');
  assert.equal(r.inventory.status, 'stale');
  assert.equal(r.demand_window.staleness_days, 19);
});

test('超卖（可售为负）不被裁剪，但会打标（公式忠实代入）', () => {
  const r = computeDocumentedSuggestion({
    plan: { plan_type: PLAN_TYPES.AVG_DAILY, coverage_days: 15 },
    sku,
    inventory: { on_hand: 2, locked: 5, in_transit: 0, snapshot_date: AS_OF },
    sales: salesOfTotal(15),
    safetyConfig: safetyFixed,
    asOf: AS_OF,
  });
  assert.equal(r.sellable_stock, -3);
  assert.ok(r.flags.includes('negative_sellable'));
  // 1×15 + 10 − (−3) = 28
  assert.equal(r.suggest_num, 28);
});

test('σ 方案：provenance=enhancement，按装箱/MOQ 落地', () => {
  const sales = dates(30).map((date, i) => ({ date, qty: 10 + (i % 3) }));
  const r = computeSigmaSuggestion({
    plan: { plan_type: PLAN_TYPES.SIGMA, lead_time_days: 5, coverage_days: 10, pack_size: 6, moq: 12, service_level: 0.95 },
    sku,
    inventory: { on_hand: 20, locked: 2, in_transit: 0, snapshot_date: AS_OF },
    sales,
    safetyConfig: { mode: 'dynamic', min_sellable_days: 7, max_sellable_days: 30 },
    asOf: AS_OF,
  });
  assert.equal(r.provenance, 'enhancement');
  assert.ok(r.assumptions.includes('H10'));
  assert.equal(r.suggest_num % 6, 0, '必须按装箱规格取整');
  assert.ok(r.suggest_num >= 12, '不低于 MOQ');
  assert.ok(r.forecast_daily > 0);
  assert.ok(r.safety_stock > 0);
});

test('computeSuggestion 按 plan_type 正确分派', () => {
  const base = {
    sku,
    inventory: { on_hand: 0, locked: 0, in_transit: 0, snapshot_date: AS_OF },
    sales: salesOfTotal(15),
    safetyConfig: safetyFixed,
    asOf: AS_OF,
  };
  const a = computeSuggestion({ ...base, plan: { plan_type: PLAN_TYPES.AVG_DAILY, coverage_days: 15 } });
  const b = computeSuggestion({ ...base, plan: { plan_type: PLAN_TYPES.SIGMA } });
  assert.equal(a.provenance, 'documented');
  assert.equal(b.provenance, 'enhancement');
});

test('解释链（why）覆盖：窗口→库存→预警→闸门→公式', () => {
  const r = computeDocumentedSuggestion({
    plan: { plan_type: PLAN_TYPES.AVG_DAILY, coverage_days: 15 },
    sku,
    inventory: { on_hand: 0, locked: 0, in_transit: 0, snapshot_date: AS_OF },
    sales: salesOfTotal(10),
    safetyConfig: safetyFixed,
    asOf: AS_OF,
  });
  const explain = explainSuggestion(r);
  assert.equal(explain.steps.length, 5);
  assert.ok(explain.steps.some((s) => s.step === '低库存闸门'));
  assert.equal(explain.rounding, '向上取整 ceil（H1）');
  assert.ok(explain.assumptions.length >= 3);
});

test('KPI 汇总在服务端完成', () => {
  const mk = (over) =>
    computeDocumentedSuggestion({
      plan: { plan_type: PLAN_TYPES.AVG_DAILY, coverage_days: 15 },
      sku,
      inventory: { on_hand: 0, locked: 0, in_transit: 0, snapshot_date: AS_OF },
      sales: salesOfTotal(over.total),
      safetyConfig: safetyFixed,
      asOf: AS_OF,
    });
  const rows = [mk({ total: 10 }), mk({ total: 30 })];
  const kpi = summarize(rows);
  assert.equal(kpi.row_count, 2);
  assert.equal(kpi.pending_count, 2);
  assert.equal(kpi.low_stock_alert_count, 2);
  // 10+10=20、30+10=40 → 合计 60 件
  assert.equal(kpi.total_suggest_qty, 60);
  assert.equal(kpi.total_amount, 60 * 22);
});
