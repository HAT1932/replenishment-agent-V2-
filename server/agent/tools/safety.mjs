/**
 * safety.mjs — 预警上下限工具（只读）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：contracts §4 #4 `safety.resolve`
 * 业务逻辑：全部委托 domain.demandWindow + domain.resolveSafetyStock。
 */
import { resolveToday, skuIdOf, toolError } from './util.mjs';
import { FRESHNESS_DAYS } from './inventory.mjs';

export function createSafetyTools() {
  return [
    {
      name: 'safety.resolve',
      provenance: 'assumption',
      write: false,
      description:
        '解析某个 SKU 的预警上下限（只读）。口径：fixed 模式取固定上下限；dynamic 模式按 min/max 可售天数 × 日均销量；' +
        '内部保留 exact 值，lower/upper 为落地取整值（假设 H5）。返回 avg_daily_sales_exact 与 formula_text 供解释用。' +
        '单位：件；日均销量单位：件/天。',
      parameters: {
        type: 'object',
        properties: {
          sku_code: { type: 'string', description: 'SKU 编码' },
          store_id: { type: 'string', description: '门店 id；不传则用该 SKU 所属门店的安全库存配置' },
        },
        required: ['sku_code'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { repository, domain } = ctx.deps;
        const asOf = await resolveToday(ctx);
        const sku = await repository.getSkuByCode(ctx.db, args.sku_code);
        if (!sku) toolError('NOT_FOUND', `SKU 不存在：${args.sku_code}`);
        const days = domain.AVG_SALES_WINDOW ?? 15;
        const sales = await repository.getSales(ctx.db, skuIdOf(sku), {
          from: domain.addDays(asOf, -(days - 1)),
          to: asOf,
        });
        const win = domain.demandWindow({
          sales: sales ?? [],
          asOf,
          days,
          freshness_days: FRESHNESS_DAYS,
        });
        const config = await repository.getSafetyConfig(ctx.db, { store_id: args.store_id ?? sku.store_id });
        const resolved = domain.resolveSafetyStock({ config, avg_daily_exact: win.avg_daily_exact });
        return {
          sku_code: sku.sku_code ?? sku.code,
          avg_daily_sales_exact: win.avg_daily_exact,
          window: {
            as_of: win.asOf,
            days: win.days,
            status: win.status,
            staleness_days: win.staleness_days,
            total: win.total,
          },
          ...resolved,
        };
      },
      meta(data) {
        return {
          provenance: 'assumption',
          assumptions: data.assumptions ?? [],
          summary: `${data.sku_code} 下限 ${data.lower} / 上限 ${data.upper}（${data.mode}）`,
          as_of: data.window?.as_of ?? null,
        };
      },
    },
  ];
}
