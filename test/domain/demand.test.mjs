import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demandWindow, buildDenseSeries, DEMAND_SCOPES } from '../../server/domain/index.mjs';

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

test('D1 回归：缺日数据不会被算成「最后 N 条记录」', () => {
  // 15 个自然日里只有 5 天有出库记录，共 10 件 → 正确日均 = 10/15 = 0.6667
  const sparse = ['2026-10-20', '2026-10-22', '2026-10-24', '2026-10-26', '2026-10-28'].map((date) => ({
    date,
    qty: 2,
  }));
  const w = demandWindow({ sales: sparse, asOf: AS_OF, days: 15 });
  assert.equal(w.total, 10);
  assert.equal(w.avg_daily_exact, 10 / 15, 'v1 会算成 2.0（放大 3 倍）');
  assert.equal(w.recorded_days, 5);
  assert.equal(w.imputed_days, 10);
  assert.equal(w.points.length, 15);

  // 同一份数据「每天落一行」时结果必须一致（口径不依赖落行方式）
  const dense = dates(15).map((date) => ({ date, qty: sparse.some((s) => s.date === date) ? 2 : 0 }));
  const w2 = demandWindow({ sales: dense, asOf: AS_OF, days: 15 });
  assert.equal(w2.avg_daily_exact, w.avg_daily_exact);
  assert.equal(w2.imputed_days, 0);
});

test('D1 回归：数据过期要能被识别（新鲜度闸门）', () => {
  const old = dates(15, '2026-10-19').map((date) => ({ date, qty: 1 })); // 最近记录 = 10-19
  const w = demandWindow({ sales: old, asOf: AS_OF, days: 15, freshness_days: 1 });
  assert.equal(w.last_recorded_date, '2026-10-19');
  assert.equal(w.staleness_days, 10);
  assert.equal(w.status, 'stale');

  const fresh = dates(15).map((date) => ({ date, qty: 1 }));
  assert.equal(demandWindow({ sales: fresh, asOf: AS_OF, days: 15 }).status, 'ok');
});

test('D1 回归：窗口之外的记录不参与计算', () => {
  const sales = [
    { date: '2026-09-01', qty: 999 }, // 窗口外
    ...dates(15).map((date) => ({ date, qty: 1 })),
  ];
  const w = demandWindow({ sales, asOf: AS_OF, days: 15 });
  assert.equal(w.total, 15);
});

test('出库类型口径：门店 = 销售 + 调拨；总部再加配送（v1 完全缺失该维度）', () => {
  const sales = dates(15).flatMap((date) => [
    { date, qty: 1, outbound_type: 'sale' },
    { date, qty: 2, outbound_type: 'transfer' },
    { date, qty: 4, outbound_type: 'delivery' },
  ]);
  const store = demandWindow({ sales, asOf: AS_OF, days: 15, scope: 'store' });
  assert.equal(store.total, 45, '门店口径 = (1+2)×15');
  assert.deepEqual(store.include, [...DEMAND_SCOPES.store]);

  const hq = demandWindow({ sales, asOf: AS_OF, days: 15, scope: 'headquarters' });
  assert.equal(hq.total, 105, '总部口径 = (1+2+4)×15');

  const onlyTransfer = demandWindow({ sales, asOf: AS_OF, days: 15, include: ['transfer'] });
  assert.equal(onlyTransfer.total, 30);
});

test('缺 outbound_type 的旧数据按 sale 处理（兼容）', () => {
  const sales = dates(15).map((date) => ({ date, qty: 2 }));
  const w = demandWindow({ sales, asOf: AS_OF, days: 15, include: ['sale'] });
  assert.equal(w.total, 30);
  assert.equal(w.avg_daily_exact, 2);
});

test('负销量被裁剪为 0（防御脏数据）', () => {
  const sales = dates(15).map((date, i) => ({ date, qty: i === 0 ? -5 : 1 }));
  const w = demandWindow({ sales, asOf: AS_OF, days: 15 });
  assert.equal(w.total, 14);
  const dense = buildDenseSeries({ sales, asOf: AS_OF, days: 15 });
  assert.ok(dense.every((p) => p.qty >= 0));
});

test('数据全空：日均 0、状态 stale、不抛错', () => {
  const w = demandWindow({ sales: [], asOf: AS_OF, days: 15 });
  assert.equal(w.total, 0);
  assert.equal(w.avg_daily_exact, 0);
  assert.equal(w.staleness_days, null);
  assert.equal(w.status, 'stale');
});
