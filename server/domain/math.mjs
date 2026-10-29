/**
 * math.mjs — 数值工具（保留精确性纪律）
 * ---------------------------------------------------------------------------
 * 修 v1 的 D2：**内部一律用 exact 浮点运算，只在「落地成件」的最后一刻取整**。
 * 取整前对「几乎等于整数」的值做 1e-9 吸附，避免 362.00000000000006 → 363 这类浮点噪声；
 * 这不是业务取整，而是浮点噪声消除（有单测覆盖）。
 */
import { validationError } from './errors.mjs';

export const EPS = 1e-9;

/** 抹掉浮点噪声后的近似整数判定 */
export function snapNearInteger(x) {
  if (!Number.isFinite(x)) return x;
  const r = Math.round(x);
  return Math.abs(x - r) < EPS ? r : x;
}

/** 向上取整（建议数量落地规则，见假设 H1） */
export function ceilInt(x) {
  const v = snapNearInteger(Number(x));
  if (!Number.isFinite(v)) throw validationError(`ceilInt 收到非有限数：${x}`);
  return Math.ceil(v);
}

/** 四舍五入到指定小数位（展示用；不得回代参与运算） */
export function roundTo(x, digits = 4) {
  const n = Number(x);
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round((n + Math.sign(n) * EPS) * f) / f;
}

/** 兼容旧名 */
export const round4 = (x) => roundTo(x, 4);

/** 按装箱规格 & 最小起订量取整（σ / 采购落地） */
export function ceilToPack(raw, packSize, moq) {
  const v = Number(raw);
  if (!(v > 0)) return 0;
  const pack = Math.max(1, Math.trunc(Number(packSize) || 1));
  const minOrder = Math.max(1, Math.trunc(Number(moq) || 1));
  let q = ceilInt(v / pack) * pack;
  if (q > 0 && q < minOrder) q = ceilInt(minOrder / pack) * pack;
  return q;
}

/** 样本标准差（n-1） */
export function stddev(values) {
  const xs = (values ?? []).map(Number).filter(Number.isFinite);
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sq = xs.reduce((a, b) => a + (b - mean) ** 2, 0);
  return Math.sqrt(sq / (xs.length - 1));
}

/** 最小二乘斜率（每步增量） */
export function linearSlope(values) {
  const ys = (values ?? []).map(Number);
  const n = ys.length;
  if (n < 2) return 0;
  const xs = ys.map((_, i) => i);
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** 加权移动平均：最近一天权重 n、最远一天权重 1（升序序列） */
export function weightedMovingAverage(values, window) {
  const xs = (values ?? []).map(Number);
  const n = Math.min(Math.max(1, Math.trunc(Number(window) || 1)), xs.length);
  if (n <= 0) return 0;
  const slice = xs.slice(xs.length - n);
  let num = 0;
  let den = 0;
  for (let i = 0; i < slice.length; i++) {
    const w = i + 1;
    num += w * slice[i];
    den += w;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * 标准正态分位数（Acklam 有理逼近，相对误差 < 1.15e-9）
 * z(0.95) ≈ 1.6449 / z(0.99) ≈ 2.3263
 */
export function zFromServiceLevel(p) {
  const x = Number(p);
  if (!(x > 0 && x < 1)) throw validationError(`service_level 必须在 (0,1) 内，收到 ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q;
  let r;
  if (x < pLow) {
    q = Math.sqrt(-2 * Math.log(x));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (x <= pHigh) {
    q = x - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - x));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** 安全库存 = max(服务水平法, 天数法)，向上取整成件 */
export function safetyStock({ sigma_lead_time = 0, forecast_daily = 0, service_level = 0.95, safety_days = 0 }) {
  const z = zFromServiceLevel(Math.min(0.999, Math.max(0.5, Number(service_level) || 0.95)));
  const ssZ = z * Math.max(0, Number(sigma_lead_time) || 0);
  const ssDays = Math.max(0, Number(forecast_daily) || 0) * Math.max(0, Number(safety_days) || 0);
  return {
    safety_stock: ceilInt(Math.max(ssZ, ssDays)),
    safety_stock_z_exact: ssZ,
    safety_stock_days_exact: ssDays,
    z: roundTo(z, 4),
    method: ssZ >= ssDays ? '服务水平法' : '天数法',
    service_level: Number(service_level),
  };
}

export function reorderPoint(forecastDaily, leadTimeDays, safetyStockQty) {
  return roundTo(
    Math.max(0, Number(forecastDaily) || 0) * Math.max(0, Number(leadTimeDays) || 0) +
      Math.max(0, Number(safetyStockQty) || 0),
    4,
  );
}

export function sigmaOverLeadTime(sigmaDaily, leadTimeDays) {
  return Math.max(0, Number(sigmaDaily) || 0) * Math.sqrt(Math.max(0, Number(leadTimeDays) || 0));
}

export function daysOfCover(available, forecastDaily) {
  if (!(Number(forecastDaily) > 0)) return Infinity;
  return Math.max(0, Number(available) || 0) / Number(forecastDaily);
}

export function turnoverRate(avgSales30d, available) {
  return roundTo((Math.max(0, Number(avgSales30d) || 0) * 30) / Math.max(1, Math.max(0, Number(available) || 0)), 4);
}
