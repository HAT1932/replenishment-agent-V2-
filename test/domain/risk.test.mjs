import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RISK_LEVELS,
  RISK_PRIORITY,
  classifyRisk,
  coverDays,
  stockoutDate,
} from '../../server/domain/index.mjs';

const asOf = '2026-10-29';
const base = { asOf, sellable: 10, in_transit: 0, avg_daily_exact: 2, suggest_num: 0, guard_alert: false };

test('可售天数：含在途；日均 0 时为 Infinity（不算断货）', () => {
  assert.equal(coverDays(10, 2), 5);
  assert.equal(coverDays(10, 0), Infinity);
  assert.equal(coverDays(-3, 2), 0, '负可售按 0 计');
});

test('预计断货日：asOf + floor(天数)；无限天数 → null', () => {
  assert.equal(stockoutDate(5, asOf), '2026-11-03');
  assert.equal(stockoutDate(0.4, asOf), '2026-10-29');
  assert.equal(stockoutDate(Infinity, asOf), null);
  assert.throws(() => stockoutDate(3, '2026-02-31'), (e) => e.code === 'VALIDATION_ERROR');
});

test('分级：缺货 > 紧急 > 建议 > 滞销 > 充足（优先级单调）', () => {
  const order = [RISK_LEVELS.STOCKOUT, RISK_LEVELS.URGENT, RISK_LEVELS.SUGGEST, RISK_LEVELS.SLOW, RISK_LEVELS.SUFFICIENT].map(
    (level) => RISK_PRIORITY[level],
  );
  for (let i = 1; i < order.length; i += 1) assert.ok(order[i] > order[i - 1]);
});

test('缺货：可售+在途为 0 且有销量', () => {
  const r = classifyRisk({ ...base, sellable: 0, in_transit: 0, avg_daily_exact: 2, suggest_num: 40, guard_alert: true });
  assert.equal(r.level, RISK_LEVELS.STOCKOUT);
  assert.equal(r.cover_days, 0);
  assert.equal(r.stockout_date, asOf);
  assert.equal(r.provenance, 'enhancement');
});

test('紧急：需要补货且可售天数 ≤ 3', () => {
  const r = classifyRisk({ ...base, sellable: 4, in_transit: 0, avg_daily_exact: 2, suggest_num: 12, guard_alert: true });
  assert.equal(r.level, RISK_LEVELS.URGENT);
  assert.equal(r.cover_days, 2);
});

test('在途能推迟断货：可售 0 + 在途 100 不算缺货', () => {
  const r = classifyRisk({ ...base, sellable: 0, in_transit: 100, avg_daily_exact: 2, suggest_num: 0 });
  assert.notEqual(r.level, RISK_LEVELS.STOCKOUT);
  assert.equal(r.cover_days, 50);
});

test('建议：需要补货但天数还够', () => {
  const r = classifyRisk({ ...base, sellable: 20, avg_daily_exact: 2, suggest_num: 5, guard_alert: true });
  assert.equal(r.level, RISK_LEVELS.SUGGEST);
});

test('滞销：低销 + 高可售天数（即使没有补货建议）', () => {
  const r = classifyRisk({ ...base, sellable: 300, avg_daily_exact: 0.2, suggest_num: 0 });
  assert.equal(r.level, RISK_LEVELS.SLOW);
  assert.match(r.reasons.join(' '), /日均/);
});

test('充足：有销量、库存够、无预警', () => {
  const r = classifyRisk({ ...base, sellable: 400, avg_daily_exact: 5, suggest_num: 0 });
  assert.equal(r.level, RISK_LEVELS.SUFFICIENT);
});

test('阈值可覆盖；stale 只进原因不改级别', () => {
  const r = classifyRisk({
    ...base,
    sellable: 4,
    avg_daily_exact: 2,
    suggest_num: 12,
    guard_alert: true,
    stale: true,
    strategy: { urgent_cover_days: 1 },
  });
  assert.equal(r.level, RISK_LEVELS.SUGGEST, '阈值收紧后不再是紧急');
  assert.ok(r.reasons.some((x) => x.includes('数据过期')));
});
