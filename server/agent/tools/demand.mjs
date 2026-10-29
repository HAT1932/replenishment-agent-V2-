/**
 * demand.mjs — 需求窗口工具（只读）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：contracts §4 #3 `demand.window`
 * 业务逻辑：全部委托 domain.demandWindow（近 N 自然日、缺日补 0、新鲜度判定都在领域内核里）。
 */
import { resolveToday, skuIdOf, toolError } from './util.mjs';
import { FRESHNESS_DAYS } from './inventory.mjs';

export function createDemandTools() {
  return [
    {
      name: 'demand.window',
      provenance: 'assumption',
      write: false,
      description:
        '读取单个 SKU 近 N 个「自然日」的需求窗口（只读）。口径（假设 H2/H7）：默认 N=15 个自然日、缺日按 0 补、' +
        '不冲减退货；默认按门店口径计入 sale+transfer（可传 include 覆盖）。avg_daily_exact 为精确值（不要自行四舍五入），' +
        'total 为窗口内总销量。返回 staleness_days 与 status（ok/stale）：销量数据过期时不得用于自动草稿。单位：件/天、件。',
      parameters: {
        type: 'object',
        properties: {
          sku_code: { type: 'string', description: 'SKU 编码' },
          days: { type: 'integer', minimum: 1, maximum: 90, description: '窗口自然日数，默认 15' },
          as_of: { type: 'string', description: '业务日期 YYYY-MM-DD，默认取数据层 today' },
          include: {
            type: 'array',
            items: { type: 'string', enum: ['sale', 'transfer', 'delivery'] },
            description: '计入需求窗口的出库类型，默认按门店口径 sale+transfer',
          },
        },
        required: ['sku_code'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { repository, domain } = ctx.deps;
        const asOf = await resolveToday(ctx, args.as_of);
        const sku = await repository.getSkuByCode(ctx.db, args.sku_code);
        if (!sku) toolError('NOT_FOUND', `SKU 不存在：${args.sku_code}`);
        const days = args.days ?? domain.AVG_SALES_WINDOW ?? 15;
        const from = domain.addDays(asOf, -(days - 1));
        const sales = await repository.getSales(ctx.db, skuIdOf(sku), { from, to: asOf });
        const result = domain.demandWindow({
          sales: sales ?? [],
          asOf,
          days,
          // 不传 include 时由领域内核按门店口径（sale+transfer）决定，避免工具层自造口径
          include: args.include,
          freshness_days: FRESHNESS_DAYS,
        });
        return { sku_code: sku.sku_code ?? sku.code, ...result };
      },
      meta(data) {
        return {
          provenance: 'assumption',
          assumptions: data.assumptions ?? ['H2', 'H7'],
          summary: `${data.sku_code} 窗口 ${data.days} 天，日均 ${data.avg_daily_exact}，状态 ${data.status}`,
          as_of: data.asOf,
        };
      },
    },
  ];
}
