/**
 * explain.mjs — 「AI 生成建议解释」：把人话写出来，但每个数字都必须能对账
 * ---------------------------------------------------------------------------
 * PRD US-01：建议必须附带决策因子解释；问题章节第一条：给数字不解释 → 商家不敢信。
 *
 * 三件事，缺一不可：
 *  1) **grounding payload**：只把确定性结果（因子/条款/口径/置信度/紧急度）交给模型，
 *     模型不允许自己算任何数字；
 *  2) **严格提示词**：四段固定结构 + 只能引用 JSON 里的数字 + 明确"增强 vs 官方口径"；
 *  3) **数值对账（verifyNumbers）**：把模型输出里的数字逐个对照 payload，未溯源的列出来。
 *     对账失败不静默——前端必须显示"未溯源数字"，这就是防幻觉的最后一道门。
 *
 * 模型不可用/超时/无 key 时，退化为 `deterministicExplanation()`：用同一份 payload 拼出
 * 结构一致的中文解释（source='deterministic'），保证离线/降级场景仍能解释。
 */
import { roundTo } from '../domain/math.mjs';

/* -------------------------------------------------------------------------- */
/* 1. grounding：给模型的唯一事实来源                                            */
/* -------------------------------------------------------------------------- */

/**
 * 从 SKU 详情 + 决策视图里抽出"可被引用的事实"，尽量扁平、带单位、便于对账。
 * @param {{detail: object, decision?: object|null}} input
 */
export function buildExplainPayload({ detail, decision = null }) {
  const suggestions = Array.isArray(detail?.suggestions) ? detail.suggestions : [];
  const documented = suggestions.find((item) => item.provenance === 'documented') ?? suggestions[0] ?? null;
  if (!documented) {
    throw Object.assign(new Error('该 SKU 没有可解释的建议（可能无库存快照）'), { code: 'DATA_MISSING' });
  }
  const window = documented.demand_window ?? {};
  const inventory = documented.inventory ?? detail?.inventory ?? {};

  return {
    /* 主体 */
    sku_code: documented.sku_code,
    product_name: documented.product_name,
    spec: documented.spec,
    unit: documented.unit,
    store_name: documented.store_name,
    as_of: documented.as_of ?? detail?.as_of,
    expected_arrival: documented.expected_arrival,

    /* 结论 */
    suggest_num: documented.suggest_num,
    suggest_raw: documented.suggest_raw,
    suggest_raw_exact: documented.suggest_raw_exact,
    rounding_note: '建议数量 = ceil(未截断值)（假设 H1）',

    /* 口径 */
    plan: {
      plan_name: documented.plan_name,
      plan_type: documented.plan_type,
      formula_text: documented.formula_text,
      provenance: documented.provenance,
    },
    formula_expr: documented.formula_expr,
    terms: documented.terms,
    /** 计划参数（模型引用"前置期 3 天""目标可售 7 天"时必须能对账） */
    plan_params: {
      purchase_cycle_days: documented.terms?.purchase_cycle_days,
      coverage_days: documented.terms?.coverage_days,
      safety_days: documented.terms?.safety_days,
      service_level: documented.terms?.service_level,
      pack_size: documented.terms?.pack_size,
      moq: documented.terms?.moq,
    },

    /* 因子（可加回） */
    factors: (documented.factors ?? []).map((item) => ({
      name: item.name,
      value: item.value,
      unit: item.unit,
      impact: item.impact,
      direction: item.direction,
      detail: item.detail,
    })),
    factor_identity: documented.factor_identity,

    /* 库存与需求事实 */
    inventory: {
      on_hand: inventory.on_hand,
      locked: inventory.locked,
      sellable: inventory.sellable,
      in_transit: inventory.in_transit,
      snapshot_date: inventory.snapshot_date,
      staleness_days: inventory.staleness_days,
    },
    stock_lower: documented.stock_lower,
    stock_upper: documented.stock_upper,
    avg_daily_sales: documented.avg_daily_sales,
    avg_daily_sales_exact: documented.avg_daily_sales_exact,
    demand_window: {
      days: window.days,
      total: window.total,
      recorded_days: window.recorded_days,
      imputed_days: window.imputed_days,
      last_recorded_date: window.last_recorded_date,
      staleness_days: window.staleness_days,
      scope: window.scope,
      include: window.include,
    },
    coefficient: {
      enabled: Boolean(documented.coefficient_enabled),
      value: documented.coefficient,
      days: Array.isArray(documented.coefficient_detail) ? documented.coefficient_detail.length : 0,
    },
    gate: documented.guard
      ? { alert: documented.guard.alert === true, policy: documented.guard.policy, text: documented.guard.text }
      : null,

    /* PRD §3.3/§3.4/§3.5 */
    confidence: documented.confidence
      ? { level: documented.confidence.level, label: documented.confidence.label, reasons: documented.confidence.reasons }
      : null,
    urgency: documented.urgency
      ? {
          level: documented.urgency.level,
          label: documented.urgency.label,
          reasons: documented.urgency.reasons,
          safety_line: documented.urgency.safety_line,
          lead_time_days: documented.urgency.lead_time_days,
          buffer_days: documented.urgency.buffer_days,
          target_cover_days: documented.urgency.target_cover_days,
        }
      : null,
    anomaly: (documented.anomaly?.items ?? []).map((item) => ({ type: item.type, label: item.label, detail: item.detail })),

    /* 决策视图（增强口径，单独标注） */
    risk: decision?.risk
      ? { level: decision.risk.level, reasons: decision.risk.reasons, cover_days: decision.risk.cover_days, stockout_date: decision.risk.stockout_date }
      : null,

    /* 溯源 */
    assumptions: documented.assumptions ?? [],
    money: { unit_cost: documented.unit_cost, amount: documented.amount },
    provenance_boundary:
      '建议数量与公式=有赞官方文档口径(documented)；置信度/紧急度/异常/风险=本实现增强(assumption/enhancement)，无官方依据',
  };
}

/* -------------------------------------------------------------------------- */
/* 2. 提示词                                                                    */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = `你是连锁零售总部商品运营的补货分析助手。你的唯一任务：用中文解释「这条补货建议为什么是这个数量」，让非技术的运营 60 秒内看懂并敢签字。

硬规则（违反任何一条即视为错误输出）：
1. 只能使用 <data> 里出现的数字。**禁止做任何四则运算后给出新数字**——需要展示加总关系时，照抄 factors 里的 impact 与 suggest_raw。
2. 数字必须带单位（件、元、天、件/天），最多保留 2 位小数（factor 里更多位时按原样引用也可以）。
3. 必须区分口径：建议数量=官方文档口径；置信度/紧急度/异常/风险=本实现增强（无官方依据）。第一次提到增强指标时点明。
4. 不要使用任何 markdown 标记（不要星号加粗、不要表格、不要反引号代码块），用纯文本；不要罗列全部字段；不要写"我计算得出"，要说"工具返回/按公式代入"。
5. 结论要能落地：给出"补多少、为什么、什么风险、下一步动作"。

输出格式（严格四段，段标题照抄，不要加序号以外的前缀）：
【结论】1–2 句：补多少件、折算金额、紧急度与置信度。
【账怎么算的】3–5 句：把 factors 按顺序念出来——哪一项推高、哪一项压低、各多少件，最后等于未截断值、向上取整成建议量。若综合系数生效，说明它作用在需求侧合计上。
【关键判断】2–3 句：库存/在途/预警下限/数据新鲜度里，最影响这次建议的 1–2 个事实；有异常就点名。
【风险与建议】1–3 句：若数据过期/超卖/异常，明确"需人工确认"；给出 1–3 个可执行动作（如"按建议量生成草稿""先核对促销排期""暂缓，先清滞销"）。

<data>
{{DATA_JSON}}
</data>`;

/**
 * 构造解释用的 messages。
 * @param {object} payload buildExplainPayload 的结果
 */
export function buildExplainMessages(payload) {
  return [
    { role: 'system', content: SYSTEM_PROMPT.replace('{{DATA_JSON}}', JSON.stringify(payload, null, 2)) },
    {
      role: 'user',
      content: '请按四段格式解释这条补货建议：为什么是这个数量、关键项各贡献多少、有什么风险、下一步做什么。',
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* 3. 数值对账                                                                  */
/* -------------------------------------------------------------------------- */

/** 从解释文本里抽取"可能被当作事实"的数字（排除日期与序号） */
export function extractNumbers(text) {
  const source = String(text ?? '');
  const withoutDates = source
    // 日期 2026-10-29 / 10-29 / 2026/10/29
    .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, ' ')
    .replace(/\b\d{1,2}[-/]\d{1,2}\b/g, ' ')
    // 段标题序号
    .replace(/^\s*\d+[.、)]/gm, ' ');
  const matches = withoutDates.match(/(?<![A-Za-z0-9])-?\d+(?:\.\d+)?(?![A-Za-z0-9])/g) ?? [];
  return [...new Set(matches)];
}

/** 收集 payload 中所有数字（含其四舍五入形态），用于对账白名单 */
export function collectAllowedNumbers(payload) {
  const allowed = new Set();
  const add = (value) => {
    if (value === null || value === undefined || value === '') return;
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    allowed.add(String(n));
    allowed.add(String(Math.trunc(n)));
    allowed.add(String(Number(n.toFixed(0))));
    allowed.add(String(Number(n.toFixed(1))));
    allowed.add(String(Number(n.toFixed(2))));
    allowed.add(String(Number(n.toFixed(4))));
    // 绝对值：文案里常说"扣减 20"而不带负号
    allowed.add(String(Math.abs(n)));
    allowed.add(String(Number(Math.abs(n).toFixed(1))));
    allowed.add(String(Number(Math.abs(n).toFixed(2))));
    allowed.add(String(Number(Math.abs(n).toFixed(4))));
  };
  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'number') return add(value);
    if (typeof value === 'string') {
      // 纯数字串直接纳入；规格类字符串（550ml*24盒）里的数量也纳入——它们同样来自服务端
      if (/^-?\d+(\.\d+)?$/.test(value)) add(value);
      else for (const token of extractNumbers(value)) add(token);
      return;
    }
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value === 'object') return Object.values(value).forEach(walk);
  };
  walk(payload);
  // 允许「可推导的百分比」：记录覆盖率 = recorded_days/days、补零占比、置信度评分
  const ratioPct = (a, b) => {
    const x = Number(a);
    const y = Number(b);
    if (!(y > 0) || !Number.isFinite(x)) return null;
    return Number(((x / y) * 100).toFixed(1));
  };
  const dw = payload.demand_window ?? {};
  for (const pct of [
    ratioPct(dw.recorded_days, dw.days),
    ratioPct(dw.imputed_days, dw.days),
    payload.confidence?.basis?.recorded_ratio !== undefined
      ? Number((Number(payload.confidence.basis.recorded_ratio) * 100).toFixed(1))
      : null,
    payload.confidence?.score !== undefined ? Number((Number(payload.confidence.score) * 100).toFixed(1)) : null,
  ]) {
    if (pct !== null) add(pct);
  }
  if (Number(dw.recorded_days) > 0 && Number(dw.recorded_days) === Number(dw.days)) add(100);
  return allowed;
}

/**
 * 对账：模型输出里的数字是否都能在 payload 找到。
 * @returns {{ok:boolean, checked:number, unknown:string[], grounded:number}}
 */
export function verifyNumbers(text, payload) {
  const allowed = collectAllowedNumbers(payload);
  const numbers = extractNumbers(text);
  const unknown = numbers.filter((token) => {
    const normalized = String(Number(token));
    if (allowed.has(token) || allowed.has(normalized)) return false;
    const n = Number(token);
    if (!Number.isFinite(n)) return false;
    // 允许对账白名单里的数的 |x| 与 percent 形态
    return !allowed.has(String(Math.abs(n)));
  });
  return {
    ok: unknown.length === 0,
    checked: numbers.length,
    grounded: numbers.length - unknown.length,
    unknown,
  };
}

/* -------------------------------------------------------------------------- */
/* 4. 确定性兜底解释                                                            */
/* -------------------------------------------------------------------------- */

/** 无模型时，用同一份 payload 拼出结构一致的解释（保证离线/降级可解释） */
export function deterministicExplanation(payload) {
  const factors = payload.factors ?? [];
  const fmt = (n) => (Number.isFinite(Number(n)) ? String(roundTo(Number(n), 2)) : '—');
  const unit = payload.unit ?? '件';
  const factorText = factors
    .map((item) => `${item.name} ${Number(item.impact) >= 0 ? '+' : ''}${fmt(item.impact)} ${unit}`)
    .join('，');
  const confidence = payload.confidence?.label ?? '未知置信度';
  const urgency = payload.urgency?.label ?? '未知紧急度';
  const anomalies = (payload.anomaly ?? []).map((item) => item.label).join('；');
  const sellable = Number(payload.inventory?.sellable ?? 0);
  const oversoldNote =
    sellable < 0
      ? `注意：可售为负（${fmt(sellable)} ${unit}，超卖），公式忠实代入后等于反向放大建议量，需人工确认。`
      : '';

  const conclusion = `【结论】按「${payload.plan?.plan_name ?? '当前方案'}」，${payload.product_name}（${payload.sku_code}）建议补 ${fmt(
    payload.suggest_num,
  )} ${unit}，折合金额 ${fmt(payload.money?.amount)} 元；紧急度 ${urgency}，置信度 ${confidence}。`;

  const how = `【账怎么算的】工具返回未截断值 ${fmt(payload.suggest_raw)} ${unit}（${
    payload.formula_expr ?? payload.plan?.formula_text ?? ''
  }）。因子分解：${factorText}；各项相加 ${fmt(payload.factor_identity?.sum ?? payload.suggest_raw)} ${unit}，向上取整得 ${fmt(
    payload.suggest_num,
  )} ${unit}。`;

  const keyFacts = `【关键判断】可售 ${fmt(sellable)} ${unit}、在途 ${fmt(
    payload.inventory?.in_transit,
  )} ${unit}、预警下限 ${fmt(payload.stock_lower)} ${unit}；日均 ${fmt(payload.avg_daily_sales)} ${unit}/天（窗口 ${
    payload.demand_window?.days ?? '—'
  } 天，补零 ${payload.demand_window?.imputed_days ?? 0} 天）。${
    anomalies ? `异常：${anomalies}。` : '未触发异常规则。'
  }${oversoldNote ? ` ${oversoldNote}` : ''}`;

  const risk = `【风险与建议】${
    payload.confidence?.level === 'low' ? '数据置信度偏低，建议先核对后再签字。' : '数据可用于自动草稿。'
  }${payload.gate?.alert === false ? '当前未触发低库存预警，可暂缓。' : '建议按建议量生成草稿，提交前仍需人工审批。'}`;

  const boundary = '（说明：建议数量为官方文档口径；置信度/紧急度/异常为本实现增强指标。）';

  return [conclusion, how, keyFacts, risk, boundary].join('\n');
}

/* -------------------------------------------------------------------------- */
/* 5. 生成入口                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 生成解释。模型不可用/失败 → 确定性兜底（不抛错，保证 UI 永远有解释）。
 * @param {{provider?: object|null, payload: object, signal?: AbortSignal, timeoutMs?: number}} input
 */
export async function generateExplanation({ provider, payload, signal, timeoutMs = 30000 }) {
  const deterministic = () => {
    const text = deterministicExplanation(payload);
    return {
      text,
      source: 'deterministic',
      model: null,
      usage: null,
      verification: verifyNumbers(text, payload),
      degraded: true,
    };
  };

  if (!provider || typeof provider.chat !== 'function') return deterministic();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await provider.chat({
      messages: buildExplainMessages(payload),
      signal: controller.signal,
    });
    const text = String(response?.message?.content ?? response?.content ?? '').trim();
    if (!text) return deterministic();
    return {
      text,
      source: 'llm',
      model: response?.model ?? provider.model ?? null,
      usage: response?.usage ?? null,
      verification: verifyNumbers(text, payload),
      degraded: false,
    };
  } catch (err) {
    const fallback = deterministic();
    return {
      ...fallback,
      degraded: true,
      error: err?.message ? String(err.message) : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
