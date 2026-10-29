import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coverageCoefficient,
  resolveSafetyStock,
  evaluateLowStockGate,
  GATE_POLICIES,
} from '../../server/domain/index.mjs';

test('综合系数：复现有赞官方算例 (1+1+1+1.1+1.2)/5 = 1.06', () => {
  // 官方算例：12/5 到货、周期 5 天（覆盖 12/5–12/9），12/8、12/9 为双休日，
  // 且 12/8 同时是重大节假日（1.2 与 1.1 取较大者）。用 2018 年（12/8=周六、12/9=周日）。
  const r = coverageCoefficient({
    arrivalDate: '2018-12-05',
    cycleDays: 5,
    weekend: { enabled: true, coefficient: 1.1 },
    holiday: { enabled: true, coefficient: 1.2 },
    holidays: ['2018-12-08'],
  });
  assert.equal(r.days, 5);
  assert.ok(Math.abs(r.total_exact - 5.3) < 1e-9, `total_exact=${r.total_exact}`);
  assert.equal(r.coefficient, 1.06);
  assert.deepEqual(r.window, { start: '2018-12-05', end: '2018-12-09' });
  assert.deepEqual(
    r.series.map((d) => d.factor),
    [1, 1, 1, 1.2, 1.1],
  );
});

test('D3 回归：<1 的系数不能被吞掉（v1 用 Math.max(1,…) 导致恒为 1）', () => {
  const r = coverageCoefficient({
    arrivalDate: '2018-12-05',
    cycleDays: 5,
    weekend: { enabled: true, coefficient: 0.8 },
  });
  // 3 个工作日 ×1 + 2 个双休日 ×0.8 = 4.6 / 5 = 0.92
  assert.ok(Math.abs(r.total_exact - 4.6) < 1e-9, `total_exact=${r.total_exact}`);
  assert.equal(r.coefficient, 0.92);
});

test('综合系数：关闭时每天恒为 1；无命中时也取 1', () => {
  const off = coverageCoefficient({ arrivalDate: '2018-12-05', cycleDays: 3 });
  assert.equal(off.coefficient, 1);
  const noHoliday = coverageCoefficient({
    arrivalDate: '2018-12-05',
    cycleDays: 3,
    weekend: { enabled: true, coefficient: 2 },
    holidays: [],
  });
  assert.equal(noHoliday.coefficient, 1, '窗口内没有双休日 → 全为工作日');
});

test('综合系数：周期必须为正整数（避免 v1「公式 7.5 天 / 窗口 8 天」）', () => {
  assert.throws(
    () => coverageCoefficient({ arrivalDate: '2026-12-05', cycleDays: 7.5 }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => coverageCoefficient({ arrivalDate: '2026-12-05', cycleDays: 0 }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => coverageCoefficient({ arrivalDate: '2026-02-31', cycleDays: 5 }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
});

test('库存预警：固定值 / 动态值两种口径', () => {
  const fixed = resolveSafetyStock({ config: { mode: 'fixed', lower_fixed: 10, upper_fixed: 100 }, avg_daily_exact: 3 });
  assert.equal(fixed.mode, 'fixed');
  assert.equal(fixed.lower, 10);
  assert.equal(fixed.upper, 100);

  const dynamic = resolveSafetyStock({
    config: { mode: 'dynamic', min_sellable_days: 7, max_sellable_days: 30 },
    avg_daily_exact: 0.6667,
  });
  assert.equal(dynamic.lower_exact, 7 * 0.6667);
  assert.equal(dynamic.lower, Math.ceil(7 * 0.6667));
  assert.equal(dynamic.upper, Math.ceil(30 * 0.6667));
  assert.ok(dynamic.upper >= dynamic.lower);

  // 零销量 → 上下限为 0（死库存不会被预警）
  const zero = resolveSafetyStock({ config: { mode: 'dynamic' }, avg_daily_exact: 0 });
  assert.equal(zero.lower, 0);
  assert.equal(zero.upper, 0);
});

test('低库存闸门：默认口径 = 实物 + 在途 < 下限（H4）', () => {
  const g1 = evaluateLowStockGate({ stock_num: 0, in_transit: 100, stock_lower: 10 });
  assert.equal(g1.alert, false, '在途足够时不算低库存');
  assert.equal(g1.policy, GATE_POLICIES.PHYSICAL_PLUS_TRANSIT);
  assert.match(g1.text, /实物库存 0 \+ 在途库存 100 = 100 ≥ 库存预警下限 10/);

  const g2 = evaluateLowStockGate({ stock_num: 4, in_transit: 5, stock_lower: 10 });
  assert.equal(g2.alert, true);
  assert.equal(g2.lhs, 9);

  // 边界：必须严格小于（FAQ：下限设 0 时库存 0 不预警）
  assert.equal(evaluateLowStockGate({ stock_num: 0, in_transit: 0, stock_lower: 0 }).alert, false);
  assert.equal(evaluateLowStockGate({ stock_num: 0, in_transit: 0, stock_lower: 1 }).alert, true);
});

test('低库存闸门：realtime 口径与物理口径结论可以不同（暴露官方文档冲突）', () => {
  const args = { stock_num: 0, in_transit: 100, stock_lower: 10 };
  assert.equal(evaluateLowStockGate(args).alert, false);
  const rt = evaluateLowStockGate({ ...args, policy: GATE_POLICIES.REALTIME });
  assert.equal(rt.alert, true, '实时库存口径下这是低库存');
  assert.equal(rt.assumption_id, 'H4');
});
