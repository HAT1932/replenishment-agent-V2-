/**
 * workbench.mjs — 决策工作台工具（只读，**增强口径**）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：`workbench.get`（v2.1 新增）
 *
 * 为什么需要它：建议表只回答"每行补多少"，但人会问"我最先补谁 / 会不会断货 / 钱压在哪"。
 * 没有这个工具时，模型只能自己去算风险（= 违反"LLM 不许自算数字"），或者答不出来。
 *
 * 口径纪律：
 *  - 数量来自 `domain/suggestion`（documented），本工具不重算；
 *  - 风险分级/可售天数/断货日/资金占用来自 `domain/risk.mjs` + `data/workbench.mjs`，
 *    一律标 `provenance='enhancement'`，并在 meta.assumptions 里带 H10，便于 UI 区分。
 */
import { resolveToday, toolError } from './util.mjs';

const MAX_TOP = 20;

/** 惰性拿到工作台读模型：优先注入（测试/其它组合），否则加载真实实现 */
async function workbenchApi(ctx) {
  const injected = ctx.deps?.workbench;
  if (injected && typeof injected.buildWorkbench === 'function') return injected;
  const mod = await import('../../data/workbench.mjs');
  if (typeof mod.buildWorkbench !== 'function') {
    throw Object.assign(new Error('工作台读模型不可用'), { code: 'INTERNAL' });
  }
  return mod;
}

export function createWorkbenchTools() {
  return [
    {
      name: 'workbench.get',
      provenance: 'enhancement',
      write: false,
      description:
        '补货工作台（只读）：一眼回答「先补谁 / 会不会断货 / 钱压在哪」。' +
        '返回风险分级（缺货/紧急/建议/滞销/充足）、可售天数、预计断货日、库存资金占用，以及服务端算好的 KPI。' +
        '其中「建议数量」是官方文档口径；「风险分级/可售天数/断货日/资金占用」是本实现增强指标（无官方依据），' +
        '回答时必须说明这一点。可按 risk 过滤、按 sort 排序取前 N 条。',
      parameters: {
        type: 'object',
        properties: {
          risk: {
            type: 'string',
            enum: ['缺货', '紧急', '建议', '滞销', '充足'],
            description: '只看某一风险等级；不传则返回全部并按风险优先级排序',
          },
          plan_id: { type: 'string', description: '补货方案 id；不传用系统默认方案' },
          keyword: { type: 'string', description: '商品名称/SKU 编码模糊筛选' },
          store_id: { type: 'string', description: '门店 id' },
          as_of: { type: 'string', description: '数据日期 YYYY-MM-DD；不传用仓储 meta 的数据日期' },
          sort: {
            type: 'string',
            enum: ['risk_priority', 'cover_days', 'amount', 'suggest_num', 'inventory_capital', 'avg_daily_sales'],
            description: '排序字段，默认 risk_priority（越紧急越靠前）',
          },
          order: { type: 'string', enum: ['asc', 'desc'], description: '排序方向' },
          limit: { type: 'integer', description: `返回前 N 条明细（1-${MAX_TOP}，默认 5）` },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const api = await workbenchApi(ctx);
        const limit = Math.min(MAX_TOP, Math.max(1, Math.trunc(Number(args.limit) || 5)));
        const asOfArg = args.as_of ? String(args.as_of) : await resolveToday(ctx);

        let data;
        try {
          data = api.buildWorkbench(ctx.db, {
            ...(args.risk ? { risk: String(args.risk) } : {}),
            ...(args.plan_id ? { plan_id: String(args.plan_id) } : {}),
            ...(args.keyword ? { keyword: String(args.keyword) } : {}),
            ...(args.store_id ? { store_id: String(args.store_id) } : {}),
            ...(args.sort ? { sort: String(args.sort) } : {}),
            ...(args.order ? { order: String(args.order) } : {}),
            as_of: asOfArg,
            page: 1,
            page_size: Math.max(limit, 20),
          });
        } catch (err) {
          if (err?.code) throw err;
          toolError('INTERNAL', `工作台计算失败：${err?.message ?? err}`);
        }

        return {
          as_of: data.as_of,
          expected_arrival: data.expected_arrival,
          plan: {
            plan_id: data.plan?.plan_id,
            plan_name: data.plan?.plan_name,
            plan_type: data.plan?.plan_type,
            formula_text: data.plan?.formula_text,
          },
          risk_levels: data.risk_levels,
          risk_strategy: data.risk_strategy,
          kpi: data.kpi,
          total: data.total,
          top: (data.rows ?? []).slice(0, limit).map((row) => ({
            sku_code: row.sku_code,
            product_name: row.product_name,
            risk_level: row.risk_level,
            risk_reasons: row.risk_reasons,
            suggest_num: row.suggest_num,
            sellable_stock: row.sellable_stock,
            in_transit_stock: row.in_transit_stock,
            avg_daily_sales: row.avg_daily_sales,
            cover_days: row.cover_days,
            stockout_date: row.stockout_date,
            inventory_capital: row.inventory_capital,
            amount: row.amount,
            provenance: row.provenance,
            risk_provenance: row.risk_provenance,
          })),
          skipped: data.skipped ?? [],
          citation: data.citation,
        };
      },
      meta(data) {
        const kpi = data.kpi ?? {};
        return {
          provenance: 'enhancement',
          assumptions: ['H1', 'H2', 'H4', 'H10'],
          summary: `缺货 ${kpi.stockout_count ?? 0} / 紧急 ${kpi.urgent_count ?? 0} / 需补货 ${
            (kpi.suggest_count ?? 0) + (kpi.urgent_count ?? 0) + (kpi.stockout_count ?? 0)
          } 个；建议合计 ${kpi.total_suggest_num ?? 0} 件；库存资金 ${Math.round(kpi.inventory_capital ?? 0)} 元（风险指标为增强口径）`,
          as_of: data.as_of ?? null,
        };
      },
    },
  ];
}
