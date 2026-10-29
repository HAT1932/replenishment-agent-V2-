import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANOMALY_TYPES,
  CONFIDENCE_LEVELS,
  URGENCY_LEVELS,
  buildDecisionFactors,
  deriveAnomalies,
  deriveConfidence,
  deriveUrgency,
  verifyFactorIdentity,
} from '../../server/domain/index.mjs';

/** 构造一条「方案 1」建议的最小骨架（字段与 domain 输出一致） */
function avgDailySuggestion(overrides = {}) {
  return {
    plan_type: 'avg_daily',
    terms: {
      avg_daily_sales_exact: 10,
      coverage_days: 15,
      stock_lower_exact: 20,
      sellable_exact: 5,
      in_transit_exact: 0,
    },
    avg_daily_sales_exact: 10,
    suggest_raw_exact: 165, // 10*15 + 20 - 5
    suggest_num: 165,
    inventory: { on_hand: 5, in_transit: 0 },
    sellable_stock: 5,
    in_transit_stock: 0,
    ...overrides,
  };
}

test('因子分解：方案 1 三项相加等于未截断建议量（解释必须"加得回去"）', () => {
  const suggestion = avgDailySuggestion();
  const factors = buildDecisionFactors(suggestion);
  assert.equal(factors.length, 3);
  const byKey = Object.fromEntries(factors.map((item) => [item.key, item]));
  assert.equal(byKey.demand.impact, 150, '需求侧 = 10 × 15');
  assert.equal(byKey.stock_lower.impact, 20);
  assert.equal(byKey.sellable.impact, -5);
  const identity = verifyFactorIdentity(suggestion);
  assert.equal(identity.ok, true);
  assert.equal(identity.sum, 165);
  assert.equal(identity.raw, 165);
});

test('因子分解：综合系数生效时单独成项，且仍可加回', () => {
  const suggestion = avgDailySuggestion({
    plan_type: 'custom',
    coefficient_enabled: true,
    terms: {
      avg_daily_sales_exact: 10,
      purchase_cycle_days: 10,
      stock_lower_exact: 20,
      sellable_exact: 0,
      in_transit_exact: 0,
      coefficient_exact: 1.1,
    },
    suggest_raw_exact: 132, // (100+20) × 1.1
  });
  const factors = buildDecisionFactors(suggestion);
  const coef = factors.find((item) => item.key === 'coefficient');
  assert.ok(coef, '缺少综合系数项');
  assert.equal(coef.direction, 'multiplier');
  assert.equal(Math.round(coef.impact * 100) / 100, 12, '系数项 impact = 基数 ×(1.1−1)');
  assert.equal(verifyFactorIdentity(suggestion).ok, true);
});

test('因子分解：方案 2 / σ 方案也能加回', () => {
  const upper = {
    plan_type: 'stock_upper',
    terms: { stock_upper_exact: 400, on_hand: 120 },
    suggest_raw_exact: 280,
    inventory: { on_hand: 120 },
  };
  assert.equal(verifyFactorIdentity(upper).ok, true);
  assert.equal(buildDecisionFactors(upper).length, 2);

  const sigma = {
    plan_type: 'sigma',
    terms: { target_stock_exact: 300, sellable_exact: 50, in_transit_exact: 30 },
    suggest_raw_exact: 220,
  };
  const identity = verifyFactorIdentity(sigma);
  assert.equal(identity.ok, true);
  assert.equal(identity.sum, 220);
});

test('因子分解：可售为负（超卖）时 impact 为正，方向标 down（扣减负数=加）', () => {
  const suggestion = avgDailySuggestion({
    terms: { avg_daily_sales_exact: 5, coverage_days: 10, stock_lower_exact: 10, sellable_exact: -3, in_transit_exact: 0 },
    suggest_raw_exact: 63, // 50 + 10 + 3
  });
  const sellable = buildDecisionFactors(suggestion).find((item) => item.key === 'sellable');
  assert.equal(sellable.impact, 3);
  assert.equal(sellable.direction, 'down');
  assert.match(sellable.detail, /超卖/);
  assert.equal(verifyFactorIdentity(suggestion).ok, true);
});

test('置信度：全有记录且新鲜 → high；全无记录 → low；部分记录 → medium', () => {
  const high = deriveConfidence({
    window: { days: 15, recorded_days: 15, imputed_days: 0, staleness_days: 0 },
    inventory: {},
  });
  assert.equal(high.level, CONFIDENCE_LEVELS.HIGH);
  assert.equal(high.provenance, 'assumption');

  const low = deriveConfidence({
    window: { days: 15, recorded_days: 0, imputed_days: 15, staleness_days: 0 },
    inventory: {},
  });
  assert.equal(low.level, CONFIDENCE_LEVELS.LOW);

  const medium = deriveConfidence({
    window: { days: 15, recorded_days: 6, imputed_days: 9, staleness_days: 3 },
    inventory: {},
  });
  assert.equal(medium.level, CONFIDENCE_LEVELS.MEDIUM);

  const stale = deriveConfidence({
    window: { days: 15, recorded_days: 15, imputed_days: 0, staleness_days: 10 },
    inventory: {},
  });
  assert.equal(stale.level, CONFIDENCE_LEVELS.LOW, '数据过期必须降级');
});

test('紧急度：PRD §3.3 三档 + §3.4 可售天数<前置期', () => {
  const plan = { config: { purchase_cycle_days: 3, safety_days: 3, coverage_days: 7 } };
  // 安全线 = 10 × (3+3) = 60；实物 20 → 0.33 ≤0.5 → critical
  const critical = deriveUrgency({
    suggestion: { avg_daily_sales_exact: 10, sellable_stock: 20, in_transit_stock: 0 },
    plan,
    inventory: { on_hand: 20, in_transit: 0 },
  });
  assert.equal(critical.level, URGENCY_LEVELS.CRITICAL);
  assert.equal(critical.safety_line, 60);
  assert.equal(critical.stock_to_safety_ratio, 0.333);

  // 实物 50 → 0.83 ≤1.0 → high
  const high = deriveUrgency({
    suggestion: { avg_daily_sales_exact: 10, sellable_stock: 50, in_transit_stock: 0 },
    plan,
    inventory: { on_hand: 50, in_transit: 0 },
  });
  assert.equal(high.level, URGENCY_LEVELS.HIGH);

  // 实物 200 → 3.3 >1.5 → high_stock
  const over = deriveUrgency({
    suggestion: { avg_daily_sales_exact: 10, sellable_stock: 200, in_transit_stock: 0 },
    plan,
    inventory: { on_hand: 200, in_transit: 0 },
  });
  assert.equal(over.level, URGENCY_LEVELS.HIGH_STOCK);
});

test('异常：飙升 / 骤降 / 缺货高风险 / 库存偏高 / 数据缺失', () => {
  const plan = { config: { purchase_cycle_days: 3, coverage_days: 7 } };
  const series = Array.from({ length: 15 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, qty: 2 }));
  const spike = deriveAnomalies({
    suggestion: { avg_daily_sales_exact: 2, sellable_stock: 4, in_transit_stock: 0 },
    plan,
    window: { days: 15, recorded_days: 15, avg_daily_exact: 2, series: [...series.slice(0, 12), { date: '2026-10-13', qty: 20 }, { date: '2026-10-14', qty: 20 }, { date: '2026-10-15', qty: 20 }] },
  });
  assert.ok(spike.types.includes(ANOMALY_TYPES.SPIKE));

  const drop = deriveAnomalies({
    suggestion: { avg_daily_sales_exact: 10, sellable_stock: 100, in_transit_stock: 0 },
    plan,
    window: { days: 15, recorded_days: 15, avg_daily_exact: 10, series: [...series.slice(0, 12).map(() => ({ qty: 10 })), { qty: 1 }, { qty: 1 }, { qty: 1 }] },
  });
  assert.ok(drop.types.includes(ANOMALY_TYPES.DROP));

  const risk = deriveAnomalies({
    suggestion: { avg_daily_sales_exact: 10, sellable_stock: 5, in_transit_stock: 0 },
    plan,
    window: { days: 15, recorded_days: 15, avg_daily_exact: 10, series },
  });
  assert.ok(risk.types.includes(ANOMALY_TYPES.STOCKOUT_RISK));

  const over = deriveAnomalies({
    suggestion: { avg_daily_sales_exact: 10, sellable_stock: 900, in_transit_stock: 0 },
    plan,
    window: { days: 15, recorded_days: 15, avg_daily_exact: 10, series },
  });
  assert.ok(over.types.includes(ANOMALY_TYPES.OVERSTOCK));

  const missing = deriveAnomalies({
    suggestion: { avg_daily_sales_exact: 0, sellable_stock: 10, in_transit_stock: 0 },
    plan,
    window: { days: 15, recorded_days: 0, imputed_days: 15, avg_daily_exact: 0, series: [] },
  });
  assert.ok(missing.types.includes(ANOMALY_TYPES.DATA_MISSING));
});
