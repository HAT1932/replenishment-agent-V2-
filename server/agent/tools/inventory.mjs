/**
 * inventory.mjs — 库存四层工具（只读）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：contracts §4 #2 `inventory.get`
 * 业务逻辑：全部委托 domain.inventorySnapshot（可售 = 实物 − 占用 等口径由领域内核决定）。
 */
import { resolveToday, skuIdOf, toolError } from './util.mjs';

/**
 * 库存快照新鲜度阈值（天）。与 domain.computeDocumentedSuggestion 的默认值保持一致（1 天），
 * 避免「工具说 stale、建议说 ok」的口径分裂。
 */
export const FRESHNESS_DAYS = 1;

export function createInventoryTools() {
  return [
    {
      name: 'inventory.get',
      provenance: 'documented',
      write: false,
      description:
        '读取单个 SKU 的库存四层（只读）。口径：on_hand=实物库存，locked=占用，sellable=可售（实物−占用），' +
        'in_transit=在途，plan_stock=计划库存；staleness_days 为库存快照距 as_of 的天数，' +
        'staleness_days > freshness_days(=1) 时 status="stale"（该 SKU 默认不进自动草稿）。单位：件。' +
        '数字均来自数据层快照与领域内核，不由 Agent 计算。',
      parameters: {
        type: 'object',
        properties: {
          sku_code: { type: 'string', description: 'SKU 编码（catalog.list_skus 返回的 sku_code）' },
        },
        required: ['sku_code'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { repository, domain } = ctx.deps;
        const asOf = await resolveToday(ctx);
        const sku = await repository.getSkuByCode(ctx.db, args.sku_code);
        if (!sku) toolError('NOT_FOUND', `SKU 不存在：${args.sku_code}`, { hint: '先用 catalog.list_skus 确认编码' });
        const inv = await repository.getInventory(ctx.db, skuIdOf(sku));
        // 缺失即 DATA_MISSING（领域内核同样如此），绝不按 0 库存处理（修 v1 的 D4）
        const snap = domain.inventorySnapshot(inv, { asOf, freshness_days: FRESHNESS_DAYS });
        return {
          sku_code: sku.sku_code ?? sku.code,
          on_hand: snap.on_hand,
          locked: snap.locked,
          sellable: snap.sellable_exact,
          in_transit: snap.in_transit,
          plan_stock: snap.plan_stock,
          snapshot_date: snap.snapshot_date,
          staleness_days: snap.staleness_days,
          status: snap.status,
          flags: snap.flags ?? [],
          as_of: asOf,
        };
      },
      meta(data) {
        return {
          provenance: 'documented',
          summary: `${data.sku_code} 可售 ${data.sellable}，在途 ${data.in_transit}，状态 ${data.status}`,
          as_of: data.as_of,
          assumptions: data.status === 'stale' ? ['H2'] : [],
        };
      },
    },
  ];
}
