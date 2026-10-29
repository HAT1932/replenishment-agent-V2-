import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhatIf, validateOverrides } from '../../server/data/whatif.mjs';
import { openDb } from '../../server/data/db.mjs';

const END = '2026-10-29';

function seeded() {
  return openDb(':memory:', { endDate: END });
}

test('validateOverrides：白名单外的参数被拒绝，合法参数被接受', () => {
  const { applied, rejected } = validateOverrides({ coverage_days: 25, magic: 1 });
  assert.deepEqual(applied, { coverage_days: 25 });
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /白名单/);
});

test('validateOverrides：边界与整数校验', () => {
  assert.equal(validateOverrides({ coverage_days: 0 }).rejected[0].key, 'coverage_days');
  assert.equal(validateOverrides({ coverage_days: 181 }).rejected[0].key, 'coverage_days');
  assert.equal(validateOverrides({ coverage_days: 7.5 }).rejected[0].reason, '必须是整数');
  assert.equal(validateOverrides({ service_level: 0.2 }).rejected[0].key, 'service_level');
});

test('What-if：改目标可售天数 → 数量变化，且给出因子级差额', () => {
  const db = seeded();
  const sku = db.prepare('SELECT code FROM skus ORDER BY id LIMIT 1').get().code;
  const result = buildWhatIf(db, sku, { as_of: END, overrides: { coverage_days: 25 } });
  assert.ok(result.before.suggest_num > 0, '前置条件：该 SKU 应有补货建议');
  assert.notEqual(result.after.suggest_num, result.before.suggest_num, '改可售天数必然影响数量');
  assert.equal(result.delta.qty, result.after.suggest_num - result.before.suggest_num);
  assert.ok(result.factor_delta.length >= 1, '应给出因子变化');
  assert.equal(result.provenance, result.after.provenance);
  db.close();
});

test('What-if：改采购周期（方案 1）只影响到货日，不改变数量 —— 必须显式告知', () => {
  const db = seeded();
  const sku = db.prepare('SELECT code FROM skus ORDER BY id LIMIT 1').get().code;
  const plan = db.prepare('SELECT plan_id FROM plans ORDER BY plan_id LIMIT 1').get().plan_id;
  const result = buildWhatIf(db, sku, { as_of: END, plan_id: plan, overrides: { purchase_cycle_days: 5 } });
  assert.equal(result.delta.qty, 0, '方案 1 的采购周期不影响建议量');
  assert.equal(result.arrival.changed, true, '但到货日必须变化');
  assert.match(result.parameter_effects.purchase_cycle_days, /预计到货日/);
  db.close();
});

test('What-if：σ 方案改服务水平会影响安全库存与数量', () => {
  const db = seeded();
  const sigmaPlan = db.prepare("SELECT plan_id FROM plans WHERE plan_type = 'sigma' LIMIT 1").get();
  assert.ok(sigmaPlan, '演示数据应含 σ 方案');
  const sku = db.prepare('SELECT code FROM skus ORDER BY id LIMIT 1').get().code;
  const result = buildWhatIf(db, sku, {
    as_of: END,
    plan_id: sigmaPlan.plan_id,
    overrides: { service_level: 0.99 },
  });
  assert.ok(result.after.suggest_num >= result.before.suggest_num, '提高服务水平不应降低建议量');
  db.close();
});

test('What-if：非法参数/未知 SKU 抛错', () => {
  const db = seeded();
  const sku = db.prepare('SELECT code FROM skus ORDER BY id LIMIT 1').get().code;
  assert.throws(() => buildWhatIf(db, sku, { as_of: END, overrides: { magic: 1 } }), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => buildWhatIf(db, 'SKU-NOT-EXIST', { as_of: END, overrides: { coverage_days: 9 } }), (e) => e.code === 'NOT_FOUND');
  db.close();
});
