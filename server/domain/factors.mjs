/**
 * factors.mjs — 决策因子分解 + 置信度 + 紧急度 + 异常标记（PRD §3.3 / §3.4 / §3.5 / US-01）
 * ---------------------------------------------------------------------------
 * PRD 的第一诉求是「建议必须附带解释，商家才敢信」。解释分两层：
 *   1) **因子分解**（本文件）：把建议量拆成「哪些项把它推高/压低了各多少件」，
 *      并且**必须加得回去**（identity: Σ impact ≈ suggest_raw_exact），否则就是讲故事；
 *   2) **自然语言解释**（server/agent/explain.mjs）：AI 用这些因子写成人话，逐句可对账。
 *
 * 纪律：
 *  - 纯函数、无 IO、`asOf` 显式传入；
 *  - 数量口径仍来自 documented 域结果（terms/plan_type），这里只做**归因**，不重算建议量；
 *  - 置信度/紧急度/异常阈值来源于 PRD（非有赞官方口径），输出带 `provenance` 与 H 编号。
 */
import { assertDate } from './dates.mjs';
import { roundTo } from './math.mjs';

/* -------------------------------------------------------------------------- */
/* 枚举                                                                        */
/* -------------------------------------------------------------------------- */

/** PRD §3.7 渐进式信任：三档置信度 */
export const CONFIDENCE_LEVELS = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' });

export const CONFIDENCE_LABEL = Object.freeze({
  high: '🟢 高置信度',
  medium: '🟡 中置信度',
  low: '🟣 低置信度',
});

/** PRD §3.3 安全库存触发三档 + §3.4 缺货高风险置顶 */
export const URGENCY_LEVELS = Object.freeze({
  CRITICAL: 'critical', // 🔴 可售天数 < 补货前置期 或 当前库存 ≤ 安全线×0.5
  HIGH: 'high', // 🟠 当前库存 ≤ 安全线×1.0（常规补货）
  NORMAL: 'normal', // 🟡 常规
  HIGH_STOCK: 'high_stock', // 🔵 库存偏高，建议暂不补
});

export const URGENCY_LABEL = Object.freeze({
  critical: '🔴 缺货高风险',
  high: '🟠 需补货',
  normal: '🟡 常规',
  high_stock: '🔵 库存偏高',
});

/** PRD §3.4 异常类型（本版实现可确定性判定的 5 类） */
export const ANOMALY_TYPES = Object.freeze({
  SPIKE: 'sales_spike',
  DROP: 'sales_drop',
  STOCKOUT_RISK: 'stockout_risk',
  OVERSTOCK: 'overstock',
  DATA_MISSING: 'data_missing',
});

export const ANOMALY_LABEL = Object.freeze({
  sales_spike: '销量飙升（近 3 天 > 窗口均值×2）',
  sales_drop: '销量骤降（近 3 天 < 窗口均值×0.3）',
  stockout_risk: '缺货高风险（可售天数 < 前置期）',
  overstock: '库存偏高（可售天数 > 目标×2）',
  data_missing: '数据缺失（窗口内无任何记录）',
});

/* -------------------------------------------------------------------------- */
/* 因子分解                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 建议量的因子分解。每项 `{ key, name, value, unit, impact, direction, detail }`
 * - `impact`：该项对建议量的**贡献（件，正=推高，负=压低）**
 * - `direction`：up / down / multiplier
 * - 恒等式：Σ impact ≈ suggest_raw_exact（未截断、未取整前）
 */
export function buildDecisionFactors(suggestion) {
  if (!suggestion) return [];
  const terms = suggestion.terms ?? {};
  const planType = suggestion.plan_type ?? suggestion.plan?.plan_type ?? '';
  /** @type {Array<{key:string,name:string,value:number|null,unit:string,impact:number,direction:string,detail:string}>} */
  const factors = [];

  const num = (key) => (terms[key] === undefined || terms[key] === null ? null : Number(terms[key]));

  const avgExact = num('avg_daily_sales_exact') ?? Number(suggestion.avg_daily_sales_exact ?? 0);
  const coverage = num('coverage_days') ?? num('purchase_cycle_days') ?? 0;
  const lower = num('stock_lower_exact');
  const upper = num('stock_upper_exact');
  const sellable = num('sellable_exact');
  const inTransit = num('in_transit_exact');
  const coef = num('coefficient_exact') ?? 1;

  if (planType === 'stock_upper') {
    // 方案 2：库存上限 − 当前实物库存
    if (upper !== null) {
      factors.push({
        key: 'stock_upper',
        name: '库存上限',
        value: roundTo(upper, 4),
        unit: '件',
        impact: roundTo(upper, 4),
        direction: 'up',
        detail: '上限 = 最大可售天数 × 日均（方案 2 的补货目标值）',
      });
    }
    const onHand = Number(suggestion.inventory?.on_hand ?? 0);
    factors.push({
      key: 'on_hand',
      name: '实物库存',
      value: onHand,
      unit: '件',
      impact: -onHand,
      direction: 'down',
      detail: '实物库存直接扣减（方案 2 不减占用/在途，见假设 H6）',
    });
  } else if (planType === 'sigma') {
    // σ 方案：目标库存 − 可售 − 在途
    const target = num('target_stock_exact') ?? num('target_stock') ?? Number(suggestion.target_stock ?? 0);
    if (target) {
      factors.push({
        key: 'target_stock',
        name: '目标库存',
        value: roundTo(target, 4),
        unit: '件',
        impact: roundTo(target, 4),
        direction: 'up',
        detail: '目标库存 = 前置期预测 + 安全库存（按服务水平）',
      });
    }
    if (sellable !== null) {
      factors.push({
        key: 'sellable',
        name: '可售库存',
        value: roundTo(sellable, 4),
        unit: '件',
        impact: -roundTo(sellable, 4),
        direction: 'down',
        detail: '可售 = 实物 − 占用（超卖时会是负数，公式忠实代入）',
      });
    }
    if (inTransit !== null && inTransit !== 0) {
      factors.push({
        key: 'in_transit',
        name: '在途库存',
        value: inTransit,
        unit: '件',
        impact: -inTransit,
        direction: 'down',
        detail: '已下单未到货，扣减后避免重复补',
      });
    }
  } else {
    // 方案 1/3：日均 × 可售天数 + 下限 − 可售（− 在途），方案 3 再乘综合系数
    const demandQty = avgExact * coverage;
    factors.push({
      key: 'demand',
      name: '需求侧（日均 × 可售天数）',
      value: roundTo(avgExact, 4),
      unit: '件/天',
      impact: roundTo(demandQty, 4),
      direction: 'up',
      detail: `${roundTo(avgExact, 4)} 件/天 × ${roundTo(coverage, 2)} 天 = ${roundTo(demandQty, 4)} 件`,
    });
    if (lower !== null) {
      factors.push({
        key: 'stock_lower',
        name: '库存预警下限',
        value: roundTo(lower, 4),
        unit: '件',
        impact: roundTo(lower, 4),
        direction: 'up',
        detail: '补到下限之上（下限口径见假设 H4/H5）',
      });
    }
    if (sellable !== null) {
      factors.push({
        key: 'sellable',
        name: '可售库存',
        value: roundTo(sellable, 4),
        unit: '件',
        impact: -roundTo(sellable, 4),
        direction: 'down',
        detail: '现有可售直接扣减（超卖为负 → 反而放大建议量，公式忠实代入）',
      });
    }
    if (inTransit !== null && inTransit !== 0) {
      factors.push({
        key: 'in_transit',
        name: '在途库存',
        value: inTransit,
        unit: '件',
        impact: -inTransit,
        direction: 'down',
        detail: '已下单未到货，扣减后避免重复补',
      });
    }
    if (suggestion.coefficient_enabled && Math.abs(coef - 1) > 1e-12) {
      const base = factors.reduce((sum, item) => sum + item.impact, 0);
      factors.push({
        key: 'coefficient',
        name: '综合系数（周末/节假日）',
        value: roundTo(coef, 6),
        unit: '×',
        impact: roundTo(base * (coef - 1), 4),
        direction: 'multiplier',
        detail: `系数 ${roundTo(coef, 6)} = Σ(每日系数)/天数，作用在需求侧合计上`,
      });
    }
  }

  return factors;
}

/** 因子恒等式校验：Σimpact 与未截断建议量的误差（用于自证"解释加得回去"） */
export function verifyFactorIdentity(suggestion, tolerance = 0.01) {
  const factors = buildDecisionFactors(suggestion);
  const sum = factors.reduce((acc, item) => acc + item.impact, 0);
  const raw = Number(suggestion?.suggest_raw_exact ?? Number.NaN);
  const diff = Number.isFinite(raw) ? Math.abs(sum - raw) : Number.NaN;
  return {
    sum: roundTo(sum, 4),
    raw: Number.isFinite(raw) ? roundTo(raw, 4) : null,
    diff: Number.isFinite(diff) ? roundTo(diff, 6) : null,
    ok: Number.isFinite(diff) ? diff <= tolerance : false,
  };
}

/* -------------------------------------------------------------------------- */
/* 置信度 / 紧急度 / 异常                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 置信度（PRD §3.5 / §3.7）：用「近 90 天有记录天数 + 缺日比例 + 数据新鲜度」判定三档。
 * PRD 的原定义是 POS 历史天数（新店 <7 / 7–30 / >30 天）；演示数据没有开店日期，
 * 因此用「窗口内可观测到的历史量」近似，并明确标注 approximation。
 */
export function deriveConfidence({ window, inventory } = {}) {
  const days = Number(window?.days ?? 15);
  const recorded = Number(window?.recorded_days ?? 0);
  const imputed = Number(window?.imputed_days ?? 0);
  const staleDays = Number(window?.staleness_days ?? inventory?.staleness_days ?? 0);
  const recordedRatio = days > 0 ? recorded / days : 0;

  /** @type {string[]} */
  const reasons = [];
  let level = CONFIDENCE_LEVELS.LOW;

  if (recorded === 0) {
    level = CONFIDENCE_LEVELS.LOW;
    reasons.push('窗口内没有任何出库记录（PRD §3.4 data_missing）');
  } else if (staleDays > 7) {
    level = CONFIDENCE_LEVELS.LOW;
    reasons.push(`数据已过期 ${staleDays} 天（POS 断连或快照未更新）`);
  } else if (recordedRatio >= 0.8 && staleDays <= 1) {
    level = CONFIDENCE_LEVELS.HIGH;
    reasons.push(`窗口 ${days} 天中 ${recorded} 天有记录（${Math.round(recordedRatio * 100)}%），数据新鲜`);
  } else {
    level = CONFIDENCE_LEVELS.MEDIUM;
    reasons.push(
      `窗口 ${days} 天中仅 ${recorded} 天有记录（补零 ${imputed} 天），或数据稍有滞后 ${staleDays} 天`,
    );
  }

  return {
    level,
    label: CONFIDENCE_LABEL[level],
    score: level === 'high' ? 0.9 : level === 'medium' ? 0.65 : 0.4,
    reasons,
    basis: {
      window_days: days,
      recorded_days: recorded,
      imputed_days: imputed,
      staleness_days: staleDays,
      recorded_ratio: roundTo(recordedRatio, 4),
    },
    approximation: 'PRD 以 POS 历史天数定义置信度；演示数据无开店日期，这里用窗口可观测历史近似',
    provenance: 'assumption',
    assumptions: ['H2', 'H7'],
  };
}

/**
 * 紧急度（PRD §3.3）：
 *   安全库存线 = 日均 × (补货前置期 + 缓冲天数)
 *   当前库存 ≤ 安全线×0.5 → 🔴；≤ 安全线×1.0 → 🟠；> 安全线×1.5 → 🔵 库存偏高
 * 另外把 PRD §3.4「可售天数 < 前置期 → 缺货高风险置顶」并入 critical。
 */
export function deriveUrgency({ suggestion, plan, inventory } = {}) {
  const avg = Number(suggestion?.avg_daily_sales_exact ?? 0);
  const leadTime = Number(plan?.config?.purchase_cycle_days ?? 3);
  const bufferDays = Number(plan?.config?.safety_days ?? 3);
  const targetCover = Number(plan?.config?.coverage_days ?? 7);
  const onHand = Number(inventory?.on_hand ?? suggestion?.inventory?.on_hand ?? 0);
  const inTransit = Number(inventory?.in_transit ?? suggestion?.in_transit_stock ?? 0);
  const available = Number(suggestion?.sellable_stock ?? 0) + inTransit;

  const safetyLine = roundTo(avg * (leadTime + bufferDays), 4);
  const coverDays = avg > 0 ? roundTo(Math.max(0, available) / avg, 2) : null;

  /** @type {string[]} */
  const reasons = [];
  let level = URGENCY_LEVELS.NORMAL;
  let ratio = null;

  if (safetyLine > 0) {
    ratio = roundTo(onHand / safetyLine, 3);
    if (ratio <= 0.5) {
      level = URGENCY_LEVELS.CRITICAL;
      reasons.push(`实物库存 ${onHand} ≤ 安全线 ${safetyLine} 的 0.5 倍`);
    } else if (ratio <= 1.0) {
      level = URGENCY_LEVELS.HIGH;
      reasons.push(`实物库存 ${onHand} ≤ 安全线 ${safetyLine}（PRD §3.3 常规补货）`);
    } else if (ratio > 1.5) {
      level = URGENCY_LEVELS.HIGH_STOCK;
      reasons.push(`实物库存 ${onHand} > 安全线 ${safetyLine} 的 1.5 倍（PRD §3.3 建议不补）`);
    }
  }

  if (coverDays !== null && coverDays < leadTime) {
    level = URGENCY_LEVELS.CRITICAL;
    reasons.push(`可售天数 ${coverDays} < 补货前置期 ${leadTime} 天（PRD §3.4 置顶）`);
  }
  if (!reasons.length) reasons.push('库存处于安全区间');

  return {
    level,
    label: URGENCY_LABEL[level],
    reasons,
    safety_line: safetyLine,
    stock_to_safety_ratio: ratio,
    cover_days: coverDays,
    lead_time_days: leadTime,
    buffer_days: bufferDays,
    target_cover_days: targetCover,
    provenance: 'assumption',
    assumptions: ['H1', 'H4'],
  };
}

/**
 * 异常标记（PRD §3.4，实现可确定性判定的 5 类）：
 *  - 销量飙升/骤降：近 3 天日均 vs 窗口日均（>2.0 / <0.3）
 *  - 缺货高风险：可售天数 < 前置期
 *  - 库存偏高：可售天数 > 目标可售天数 × 2
 *  - 数据缺失：窗口内无记录
 */
export function deriveAnomalies({ suggestion, plan, window } = {}) {
  const series = Array.isArray(window?.series) ? window.series : [];
  const windowAvg = Number(window?.avg_daily_exact ?? suggestion?.avg_daily_sales_exact ?? 0);
  const leadTime = Number(plan?.config?.purchase_cycle_days ?? 3);
  const targetCover = Number(plan?.config?.coverage_days ?? 7);

  /** @type {Array<{type:string,label:string,severity:'warn'|'info'|'danger',detail:string}>} */
  const anomalies = [];

  if (series.length >= 3) {
    const recent = series.slice(-3);
    const recentAvg = recent.reduce((sum, point) => sum + Number(point.qty ?? 0), 0) / recent.length;
    if (windowAvg > 0 && recentAvg > windowAvg * 2) {
      anomalies.push({
        type: ANOMALY_TYPES.SPIKE,
        label: ANOMALY_LABEL[ANOMALY_TYPES.SPIKE],
        severity: 'warn',
        detail: `近 3 天日均 ${roundTo(recentAvg, 2)} vs 窗口日均 ${roundTo(windowAvg, 2)}`,
      });
    } else if (windowAvg > 0 && recentAvg < windowAvg * 0.3) {
      anomalies.push({
        type: ANOMALY_TYPES.DROP,
        label: ANOMALY_LABEL[ANOMALY_TYPES.DROP],
        severity: 'warn',
        detail: `近 3 天日均 ${roundTo(recentAvg, 2)} vs 窗口日均 ${roundTo(windowAvg, 2)}：建议按窗口均值而非近 3 天`,
      });
    }
  }

  const coverDays = Number(suggestion?.days_of_cover ?? Number.NaN);
  const avg = Number(suggestion?.avg_daily_sales_exact ?? 0);
  const cover = Number.isFinite(coverDays)
    ? coverDays
    : avg > 0
      ? Math.max(0, Number(suggestion?.sellable_stock ?? 0) + Number(suggestion?.in_transit_stock ?? 0)) / avg
      : null;

  if (cover !== null && cover < leadTime) {
    anomalies.push({
      type: ANOMALY_TYPES.STOCKOUT_RISK,
      label: ANOMALY_LABEL[ANOMALY_TYPES.STOCKOUT_RISK],
      severity: 'danger',
      detail: `可售 ${roundTo(cover, 2)} 天 < 前置期 ${leadTime} 天`,
    });
  }
  if (cover !== null && cover > targetCover * 2) {
    anomalies.push({
      type: ANOMALY_TYPES.OVERSTOCK,
      label: ANOMALY_LABEL[ANOMALY_TYPES.OVERSTOCK],
      severity: 'info',
      detail: `可售 ${roundTo(cover, 2)} 天 > 目标 ${targetCover} 天 × 2`,
    });
  }
  if (Number(window?.recorded_days ?? 1) === 0) {
    anomalies.push({
      type: ANOMALY_TYPES.DATA_MISSING,
      label: ANOMALY_LABEL[ANOMALY_TYPES.DATA_MISSING],
      severity: 'info',
      detail: '窗口内无出库记录，日均按 0 计（缺日补零，见 H2/H7）',
    });
  }

  return { items: anomalies, types: anomalies.map((item) => item.type) };
}
