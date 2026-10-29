/**
 * inventory.mjs — 库存四层快照
 * ---------------------------------------------------------------------------
 * 文档口径（进出存使用教程 detail_5_5-2-60857）：
 *   实物库存 / 占用库存 / 可售库存（= 实物 − 占用）/ 在途库存；另有「计划库存」为虚拟库存。
 *
 * 修 v1 的 D4：inventory 行缺失时 v1 当成 0 库存，直接给出「最大补货量 + 紧急 + 缺货」的假信号。
 * 本实现：缺失即抛 DATA_MISSING，由上层决定跳过并记录，绝不静默按 0 计算。
 */
import { assertDate, diffDays } from './dates.mjs';
import { dataMissing, validationError } from './errors.mjs';

function num(value, field, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw validationError(`${field} 必须为数字，收到 ${JSON.stringify(value)}`);
  return n;
}

/**
 * @param {{on_hand:number, locked?:number, allocated?:number, in_transit?:number,
 *          plan_stock?:number, snapshot_date?:string}} inventory
 * @param {{asOf:string, freshness_days?:number}} options
 */
export function inventorySnapshot(inventory, { asOf, freshness_days = 1 } = {}) {
  assertDate(asOf, 'asOf');
  if (!inventory) {
    throw dataMissing('该 SKU 没有库存快照（inventory 缺失），不能按 0 库存处理');
  }

  const onHand = num(inventory.on_hand, 'on_hand');
  const locked = num(inventory.locked ?? inventory.allocated, 'locked', 0);
  const inTransit = num(inventory.in_transit, 'in_transit', 0);
  const planStock = num(inventory.plan_stock, 'plan_stock', 0);
  const sellableExact = onHand - locked;

  const snapshotDate = inventory.snapshot_date
    ? assertDate(String(inventory.snapshot_date).slice(0, 10), 'snapshot_date')
    : null;
  const stalenessDays = snapshotDate ? Math.max(0, diffDays(snapshotDate, asOf)) : null;
  const freshLimit = Math.max(0, Math.trunc(Number(freshness_days) || 0));
  const status = stalenessDays === null || stalenessDays > freshLimit ? 'stale' : 'ok';

  /** @type {string[]} */
  const flags = [];
  if (sellableExact < 0) flags.push('negative_sellable');
  if (onHand < 0) flags.push('negative_on_hand');

  return {
    on_hand: onHand,
    locked,
    sellable_exact: sellableExact,
    sellable: sellableExact,
    in_transit: inTransit,
    plan_stock: planStock,
    snapshot_date: snapshotDate,
    staleness_days: stalenessDays,
    freshness_days: freshLimit,
    status,
    flags,
  };
}
