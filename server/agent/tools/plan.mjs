/**
 * plan.mjs — 补货方案工具（只读）+ 方案解析辅助
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：contracts §4 #7 `plan.list`
 * 业务逻辑：无；方案配置来自数据层，公式文案来自 domain.formulaText。
 */

/**
 * 解析本次要使用的方案。
 * 优先级：显式 plan 对象 > plan_id > 数据层默认方案 > domain.DEFAULT_PLAN_CONFIG。
 * @param {{repository: any, domain: any, db: unknown, plan_id?: string, plan?: object}} input
 */
export async function resolvePlan({ repository, domain, db, plan_id, plan }) {
  const fallbackConfig = domain.DEFAULT_PLAN_CONFIG ?? {};
  if (plan && typeof plan === 'object') {
    const config = { ...fallbackConfig, ...(plan.config ?? plan) };
    return normalizePlan({ ...plan, config }, domain);
  }
  let plans = [];
  try {
    plans = (await repository.listPlans(db)) ?? [];
  } catch {
    plans = [];
  }
  if (plan_id) {
    const hit = plans.find((p) => p.plan_id === plan_id) ?? (await tryGetPlan(repository, db, plan_id));
    if (!hit) {
      const err = new Error(`方案不存在：${plan_id}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    return normalizePlan(hit, domain);
  }
  const preferred = plans.find((p) => p.is_default) ?? plans[0] ?? null;
  if (preferred) return normalizePlan(preferred, domain);
  return {
    plan_id: null,
    plan_name: '默认方案',
    plan_type: fallbackConfig.plan_type ?? 'avg_daily',
    provenance: 'documented',
    config: { ...fallbackConfig },
    formula_text: safeFormulaText(domain, fallbackConfig),
  };
}

async function tryGetPlan(repository, db, planId) {
  if (typeof repository.getPlan !== 'function') return null;
  try {
    return await repository.getPlan(db, planId);
  } catch {
    return null;
  }
}

function normalizePlan(plan, domain) {
  const config = plan.config ?? {
    plan_type: plan.plan_type,
    purchase_cycle_days: plan.purchase_cycle_days,
    coverage_days: plan.coverage_days,
    coefficient_enabled: plan.coefficient_enabled,
    weekend_coefficient_enabled: plan.weekend_coefficient_enabled,
    weekend_coefficient: plan.weekend_coefficient,
    holiday_coefficient_enabled: plan.holiday_coefficient_enabled,
    holiday_coefficient: plan.holiday_coefficient,
  };
  return {
    plan_id: plan.plan_id ?? plan.id ?? null,
    plan_name: plan.plan_name ?? plan.name ?? '未命名方案',
    plan_type: config.plan_type ?? plan.plan_type ?? 'avg_daily',
    provenance: plan.provenance ?? 'documented',
    config,
    formula_text: plan.formula_text ?? safeFormulaText(domain, config),
  };
}

function safeFormulaText(domain, config) {
  if (typeof domain?.formulaText !== 'function') return '';
  try {
    return domain.formulaText(config) ?? '';
  } catch {
    return '';
  }
}

export function createPlanTools() {
  return [
    {
      name: 'plan.list',
      provenance: 'documented',
      write: false,
      description:
        '列出全部补货方案（只读）。口径：返回方案 id/名称/类型（avg_daily|stock_upper|custom）、' +
        '公式文案 formula_text、provenance（documented|enhancement|assumption）以及完整 config（采购周期、覆盖天数、系数开关）。' +
        '返回单位：条数。写方案需人在页面上操作，Agent 不修改方案。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        const { repository, domain } = ctx.deps;
        const plans = (await repository.listPlans(ctx.db)) ?? [];
        return {
          plans: plans.map((p) => ({
            plan_id: p.plan_id ?? p.id ?? null,
            plan_name: p.plan_name ?? p.name ?? '未命名方案',
            plan_type: p.config?.plan_type ?? p.plan_type ?? null,
            formula_text: p.formula_text ?? safeFormulaText(domain, p.config ?? p),
            provenance: p.provenance ?? 'documented',
            config: p.config ?? null,
          })),
        };
      },
      meta(data) {
        return { provenance: 'documented', summary: `返回 ${data.plans.length} 个方案` };
      },
    },
  ];
}
