/**
 * suggestion.mjs — 补货建议工具（只读）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：contracts §4 #5 `suggestion.compute`、#6 `suggestion.explain`
 *
 * 纪律：本文件**不做任何业务计算**。
 *  - 优先使用数据层读模型 `server/data/queries.mjs#buildSuggestions`（内部已按仓迭代 + 调域层 + 算 kpi）；
 *  - 回退路径：domain.computeSuggestion（方案 1/2/3 + σ）逐条计算；
 *  - 本文件只负责：筛 SKU、取数、组装表格 / KPI / artifact，不产生任何独立口径。
 *
 * 溯源：meta.provenance / assumptions 一律从域层结果（row.provenance / row.assumptions）透传。
 */
import { resolveToday, skuIdOf, toolError, clampInt } from './util.mjs';
import { resolvePlan } from './plan.mjs';
import { FRESHNESS_DAYS } from './inventory.mjs';

const BULK_LIMIT = 500; // 内部批量上限：契约未定义分页，先按 500 保护
const DEFAULT_DAYS = 15;

function guardNote() {
  return (
    '口径：建议数量 = ceil(公式)（假设 H1）；方案 1/2/3 与官方文档一致（documented）；' +
    '低库存闸门：实物库存 + 在途 < 下限（假设 H4，可切 realtime 口径）；' +
    '仅展示建议数量 > 0 的行（假设 H8）；staleness_days > freshness_days 的行标记 stale_data。'
  );
}

/** 归一化 SKU 字段名，喂给域层（域层接受 code/sku_code、name/product_name、id/sku_id） */
function normalizeSku(sku) {
  return {
    ...sku,
    id: sku.id ?? sku.sku_id ?? null,
    code: sku.code ?? sku.sku_code,
    name: sku.name ?? sku.product_name ?? '',
  };
}

/** 域层 Suggestion 里用于 meta 的溯源三件套 */
function traceFromRows(rows, plan) {
  const assumptions = [...new Set(rows.flatMap((r) => r.assumptions ?? []))];
  return {
    provenance: rows[0]?.provenance ?? plan.provenance ?? 'documented',
    assumptions,
    as_of: rows[0]?.as_of ?? null,
  };
}

/** 用数据层读模型（若可用）；返回 null 表示需要回退到手工组装 */
async function tryBuildViaQueries(args, ctx) {
  const queries = ctx.deps.queries;
  if (!queries || typeof queries.buildSuggestions !== 'function') return null;
  // 读模型不支持 sku_codes 精确过滤 → 这类请求走域层逐条计算，保证契约语义
  if (Array.isArray(args.sku_codes) && args.sku_codes.length) return null;
  // 传参严格按 Lead 给的读模型签名
  const q = await queries.buildSuggestions(ctx.db, {
    plan_id: args.plan_id,
    store_id: args.store_id,
    category: args.category,
    keyword: args.keyword,
    as_of: args.as_of,
    expected_arrival: args.expected_arrival,
    only_low: args.only_low,
    page: 1,
    page_size: clampInt(args.limit, 1, BULK_LIMIT, BULK_LIMIT),
    scope: args.scope,
  });
  if (!q || !Array.isArray(q.rows)) return null;
  return q;
}

/** 取 SKU 列表（sku_codes 优先，否则按过滤条件） */
async function loadSkus(args, ctx) {
  const { repository } = ctx.deps;
  if (Array.isArray(args.sku_codes) && args.sku_codes.length) {
    const out = [];
    const skipped = [];
    for (const code of args.sku_codes) {
      const sku = await repository.getSkuByCode(ctx.db, code);
      if (sku) out.push(sku);
      else skipped.push(code);
    }
    if (!out.length) toolError('NOT_FOUND', `未找到任何 SKU：${skipped.join(', ')}`);
    return { skus: out, skipped };
  }
  const rows = await repository.listSkus(ctx.db, {
    store_id: args.store_id,
    category: args.category,
    keyword: args.keyword,
    limit: clampInt(args.limit, 1, BULK_LIMIT, BULK_LIMIT),
  });
  return { skus: rows ?? [], skipped: [] };
}

/** 回退路径：逐 SKU 调域层计算（唯一业务入口） */
async function computeRowsFallback(args, ctx) {
  const { repository, domain } = ctx.deps;
  const asOf = await resolveToday(ctx, args.as_of);
  const plan = await resolvePlan({ repository, domain, db: ctx.db, plan_id: args.plan_id, plan: args.plan });
  const holidays = typeof repository.listHolidays === 'function' ? (await repository.listHolidays(ctx.db)) ?? [] : [];
  const safetyConfig = typeof repository.getSafetyConfig === 'function'
    ? await repository.getSafetyConfig(ctx.db, { store_id: args.store_id })
    : undefined;
  const { skus, skipped } = await loadSkus(args, ctx);
  const days = domain.AVG_SALES_WINDOW ?? DEFAULT_DAYS;
  const rows = [];
  const missingInventory = [];
  for (const rawSku of skus) {
    const skuCode = rawSku.sku_code ?? rawSku.code;
    const inv = await repository.getInventory(ctx.db, skuIdOf(rawSku));
    if (!inv) {
      // 缺库存快照不按 0 处理（修 v1 的 D4）；与 queries.buildSuggestions 的 skipped 形状保持一致
      missingInventory.push({ sku_code: skuCode, code: 'DATA_MISSING', message: `SKU ${skuCode} 没有库存快照` });
      continue;
    }
    const sales = await repository.getSales(ctx.db, skuIdOf(rawSku), {
      from: domain.addDays(asOf, -(days - 1)),
      to: asOf,
    });
    const row = domain.computeSuggestion({
      // 域层直接从 rawPlan 读 plan_id/plan_name，因此合并 config 后透传
      plan: { ...plan.config, plan_id: plan.plan_id, plan_name: plan.plan_name },
      sku: normalizeSku(rawSku),
      inventory: inv,
      sales: sales ?? [],
      safetyConfig,
      holidays,
      asOf,
      expectedArrival: args.expected_arrival,
      freshness_days: FRESHNESS_DAYS,
    });
    rows.push(row);
  }
  const filtered = args.only_low === true ? rows.filter((r) => r.guard?.alert === true) : rows;
  const skippedAll = [
    ...skipped.map((code) => ({ sku_code: code, code: 'NOT_FOUND', message: `未找到 SKU ${code}` })),
    ...missingInventory,
  ];
  return {
    asOf,
    plan,
    rows: filtered,
    skipped: skippedAll,
  };
}

/** 统一给 explain 用：逐 SKU 走域层计算（sklearn_codes 精确过滤，读模型不支持） */
async function explainOne(args, ctx) {
  const { asOf, plan, rows } = await computeRowsFallback(
    {
      plan_id: args.plan_id,
      plan: args.plan,
      sku_codes: [args.sku_code],
      as_of: args.as_of,
      expected_arrival: args.expected_arrival,
    },
    ctx,
  );
  return { row: rows[0], asOf, plan };
}

export function createSuggestionTools() {
  return [
    {
      name: 'suggestion.compute',
      provenance: 'documented',
      write: false,
      description:
        '按指定方案批量计算补货建议（只读，不落库）。口径：方案 1（日均销量）/方案 2（库存上限）/方案 3（自定义），' +
        '含日历综合系数（假设 H3）、低库存闸门（H4）与 ceil 取整（H1）；每行都带 provenance（documented/enhancement/assumption）、' +
        'assumptions、terms 与 guard，可逐项审计。支持 store_id/category/keyword/sku_codes 过滤，only_low=true 只返回触发低库存闸门的行。' +
        '返回单位：数量=件，金额=元；建议数量 suggest_num 为只读展示值，人工可改的是 apply_num。',
      parameters: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', description: '方案 id；不传使用数据层默认方案' },
          plan: { type: 'object', description: '临时方案配置（覆盖 plan_id），需符合方案 config 形状' },
          store_id: { type: 'string', description: '门店 id' },
          sku_codes: { type: 'array', items: { type: 'string' }, description: '指定 SKU 编码列表' },
          category: { type: 'string', description: '分类过滤' },
          keyword: { type: 'string', description: 'SKU/品名关键词' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: '批量上限，默认 500（内部保护）' },
          as_of: { type: 'string', description: '业务日期 YYYY-MM-DD，默认数据层 today' },
          expected_arrival: { type: 'string', description: '预计到货日 YYYY-MM-DD（影响系数窗口）' },
          only_low: { type: 'boolean', description: '仅返回触发低库存闸门的行' },
          scope: { type: 'string', enum: ['store', 'headquarters'], description: '需求口径，默认 store' },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { domain } = ctx.deps;
        let asOf;
        let plan;
        let rows;
        let kpi;
        let formulaText;
        let skipped = [];
        const viaQuery = await tryBuildViaQueries(args, ctx);
        if (viaQuery) {
          rows = viaQuery.rows ?? [];
          asOf = viaQuery.as_of ?? rows[0]?.as_of ?? (await resolveToday(ctx, args.as_of));
          plan = viaQuery.plan ?? (await resolvePlan({ repository: ctx.deps.repository, domain, db: ctx.db, plan_id: args.plan_id, plan: args.plan }));
          kpi = viaQuery.kpi ?? domain.summarize(rows);
          formulaText = viaQuery.formula_text ?? rows[0]?.formula_text ?? plan.formula_text;
          skipped = viaQuery.skipped ?? [];
        } else {
          const manual = await computeRowsFallback(args, ctx);
          asOf = manual.asOf;
          plan = manual.plan;
          rows = manual.rows;
          kpi = domain.summarize ? domain.summarize(rows) : {};
          formulaText = rows[0]?.formula_text ?? plan.formula_text;
          skipped = manual.skipped;
        }
        const trace = traceFromRows(rows, plan);
        return {
          as_of: asOf,
          expected_arrival: rows[0]?.expected_arrival ?? args.expected_arrival ?? null,
          formula_text: formulaText,
          plan: {
            plan_id: plan.plan_id,
            plan_name: plan.plan_name,
            plan_type: plan.plan_type,
            provenance: plan.provenance,
            config: plan.config,
          },
          rows,
          kpi,
          guard_note: guardNote(),
          skipped,
          assumptions: trace.assumptions,
        };
      },
      meta(data) {
        const provenance = data.rows[0]?.provenance ?? data.plan.provenance ?? 'documented';
        return {
          provenance,
          assumptions: data.assumptions,
          as_of: data.as_of,
          summary: `方案「${data.plan.plan_name}」：${data.kpi?.row_count ?? data.rows.length} 行，` +
            `低库存 ${data.kpi?.low_stock_alert_count ?? 0} 行，建议合计 ${data.kpi?.total_suggest_qty ?? 0}，金额 ${data.kpi?.total_amount ?? 0} 元`,
          artifacts: [
            {
              kind: 'suggestions',
              title: `补货建议 · ${data.plan.plan_name}`,
              ref: {
                as_of: data.as_of,
                expected_arrival: data.expected_arrival,
                plan_id: data.plan.plan_id,
                row_count: data.rows.length,
                kpi: data.kpi,
              },
            },
          ],
        };
      },
    },
    {
      name: 'suggestion.explain',
      provenance: 'documented',
      write: false,
      description:
        '解释单个 SKU 的建议数量是怎么来的（只读）。口径与 suggestion.compute 完全一致，返回域层 explainSuggestion 投影：' +
        'terms（各项精确值）、coefficient.detail（逐日系数与原因）、guard（低库存闸门判定）、suggest_raw_exact（取整前精确值）、' +
        'steps（why 步骤）与 assumptions。不重新计算、不做二次四舍五入。单位：件、件/天、金额=元。',
      parameters: {
        type: 'object',
        properties: {
          sku_code: { type: 'string', description: '要解释的 SKU 编码' },
          plan_id: { type: 'string', description: '方案 id；不传使用默认方案' },
          plan: { type: 'object', description: '临时方案配置（覆盖 plan_id）' },
          as_of: { type: 'string', description: '业务日期 YYYY-MM-DD' },
          expected_arrival: { type: 'string', description: '预计到货日 YYYY-MM-DD' },
        },
        required: ['sku_code'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { domain } = ctx.deps;
        const { row, asOf, plan } = await explainOne(args, ctx);
        if (!row) toolError('DATA_MISSING', `SKU ${args.sku_code} 缺少库存/销量数据，无法解释`);
        const explained = typeof domain.explainSuggestion === 'function'
          ? domain.explainSuggestion(row)
          : {
              terms: row.terms,
              guard: row.guard,
              coefficient: { enabled: row.coefficient_enabled, value: row.coefficient, detail: row.coefficient_detail },
              suggest_raw_exact: row.suggest_raw_exact,
              suggest_num: row.suggest_num,
              assumptions: row.assumptions,
              steps: row.why ?? [],
              factors: row.factors ?? [],
              factor_identity: row.factor_identity ?? null,
              confidence: row.confidence ?? null,
              urgency: row.urgency ?? null,
              anomaly: row.anomaly ?? null,
            };
        return {
          sku_code: row.sku_code,
          as_of: asOf ?? row.as_of,
          expected_arrival: row.expected_arrival,
          plan: {
            plan_id: plan?.plan_id ?? row.plan_id,
            plan_name: plan?.plan_name ?? row.plan_name,
            plan_type: row.plan_type,
            provenance: row.provenance,
          },
          formula_text: row.formula_text,
          formula_expr: row.formula_expr,
          ...explained,
        };
      },
      meta(data) {
        return {
          provenance: data.provenance ?? 'documented',
          assumptions: data.assumptions ?? [],
          as_of: data.as_of,
          summary: `${data.sku_code}：精确值 ${data.suggest_raw_exact} → 建议 ${data.suggest_num}`,
          artifacts: [
            {
              kind: 'explain',
              title: `建议解释 · ${data.sku_code}`,
              ref: { sku_code: data.sku_code, as_of: data.as_of, plan_type: data.plan?.plan_type },
            },
          ],
        };
      },
    },
    {
      name: 'suggestion.whatif',
      provenance: 'documented',
      write: false,
      description:
        'What-if 确定性重算（只读）：改「补货前置期 / 目标可售天数 / 缓冲天数 / 服务水平」后，用**同一个域内核**重算建议量，' +
        '返回 before/after 与差额、因子级变化。不要自己估算差额——差额只能来自这个工具。' +
        '白名单参数：purchase_cycle_days(1-90) / coverage_days(1-180) / safety_days(0-60) / service_level(0.5-0.999)。',
      parameters: {
        type: 'object',
        properties: {
          sku_code: { type: 'string', description: 'SKU 编码' },
          plan_id: { type: 'string', description: '方案 id；不传用默认方案' },
          as_of: { type: 'string', description: '业务日期 YYYY-MM-DD' },
          overrides: {
            type: 'object',
            description: '要覆盖的参数，例如 { "purchase_cycle_days": 5 }',
            properties: {
              purchase_cycle_days: { type: 'integer', description: '补货前置期/采购周期（天）' },
              coverage_days: { type: 'integer', description: '目标可售天数（天）' },
              safety_days: { type: 'number', description: '缓冲天数' },
              service_level: { type: 'number', description: '服务水平（σ 方案）' },
            },
            additionalProperties: false,
          },
          expected_arrival: { type: 'string', description: '预计到货日 YYYY-MM-DD' },
        },
        required: ['sku_code', 'overrides'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const mod = await import('../../data/whatif.mjs');
        const asOf = args.as_of ? String(args.as_of) : await resolveToday(ctx);
        try {
          return mod.buildWhatIf(ctx.db, args.sku_code, {
            as_of: asOf,
            plan_id: args.plan_id,
            overrides: args.overrides ?? {},
            expected_arrival: args.expected_arrival,
          });
        } catch (err) {
          if (err?.code) throw err;
          toolError('INTERNAL', `What-if 重算失败：${err?.message ?? err}`);
        }
      },
      meta(data) {
        const delta = data.delta?.qty ?? 0;
        return {
          provenance: data.provenance ?? 'documented',
          assumptions: data.assumptions ?? [],
          as_of: data.as_of ?? null,
          summary: `${data.sku?.sku_code ?? ''} What-if：${data.before?.suggest_num} → ${data.after?.suggest_num} 件（${delta >= 0 ? '+' : ''}${delta}）`,
        };
      },
    },
  ];
}