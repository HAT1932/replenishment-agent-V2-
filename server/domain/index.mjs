/**
 * index.mjs — 领域内核唯一出口
 * ---------------------------------------------------------------------------
 * 全部纯函数：无 IO、无系统时钟（时间由 `asOf` 显式传入）、无全局状态。
 * 该模块是 Agent 的「确定性计算内核」：LLM 只能通过工具调用这里，不能自算数字。
 */
export * from './errors.mjs';
export * from './dates.mjs';
export * from './math.mjs';
export * from './plans.mjs';
export * from './assumptions.mjs';
export * from './inventory.mjs';
export * from './demand.mjs';
export * from './safety.mjs';
export * from './calendar.mjs';
export * from './suggestion.mjs';

export const DOMAIN_VERSION = '2.0.0';
export * from './risk.mjs';
export * from './factors.mjs';
