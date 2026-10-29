/**
 * catalog.mjs — SKU 主数据工具（只读）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：contracts §4 #1 `catalog.list_skus`
 * 业务逻辑：无。全部委托 repository.listSkus（数据层）。
 */
import { clampInt } from './util.mjs';

/**
 * @param {{db: unknown}} deps
 */
export function createCatalogTools() {
  return [
    {
      name: 'catalog.list_skus',
      provenance: 'documented',
      write: false,
      description:
        '列出可补货的 SKU 主数据（只读）。口径：按门店/分类/关键词过滤后返回 SKU 编码、品名、规格、单位、分类与所属门店；' +
        '不含任何库存或销量数字（库存请调 inventory.get，销量口径请调 demand.window）。返回单位：条数（limit 默认 50，最大 200）；' +
        '数量单位随 SKU 的 unit 字段（件/箱）。',
      parameters: {
        type: 'object',
        properties: {
          store_id: { type: 'string', description: '门店 id；不传则跨门店' },
          category: { type: 'string', description: '分类名（精确匹配，由数据层实现）' },
          keyword: { type: 'string', description: 'SKU 编码 / 编码数字 / 品名关键词' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '返回条数上限，默认 50' },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { repository } = ctx.deps;
        const limit = clampInt(args.limit, 1, 200, 50);
        const rows = await repository.listSkus(ctx.db, {
          store_id: args.store_id,
          category: args.category,
          keyword: args.keyword,
          limit,
        });
        return {
          skus: (rows ?? []).map((sku) => ({
            sku_code: sku.sku_code ?? sku.code,
            sku_no: sku.sku_no ?? null,
            product_name: sku.product_name ?? sku.name ?? '',
            spec: sku.spec ?? null,
            unit: sku.unit ?? null,
            category: sku.category ?? null,
            store_id: sku.store_id ?? null,
            store_name: sku.store_name ?? null,
          })),
        };
      },
      meta(data) {
        return {
          provenance: 'documented',
          summary: `返回 ${data.skus.length} 个 SKU`,
          as_of: null,
        };
      },
    },
  ];
}
