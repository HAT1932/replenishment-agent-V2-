/**
 * index.mjs — 工具注册表（JSON Schema + 描述 + 审计 + 超时 + 审批提取）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 *
 * 职责（唯一入口，runtime / scheduler / HTTP 都走这里）：
 *  1) 汇总各域工具，生成 OpenAI tools schema；
 *  2) 参数校验（挡住模型乱传参）→ 执行 → 统一信封 `{ok,data,meta}` / `{ok:false,error}`；
 *  3) **每次调用双审计**：tool_call（入参，dry + 2KB 截断）与 tool_result（结果/错误、耗时、provenance）；
 *  4) 单工具超时（AbortController + Promise.race，默认 20s）；
 *  5) 把 domain 结果里的 provenance/assumptions 与写操作的 approval/artifacts 透传进 meta，
 *     由 runtime 转成 SSE 的 `approval_required` / `artifact` 事件。
 *
 * 命名：契约里的工具名是 `domain.action`（如 suggestion.compute），但 OpenAI function name
 * 只允许 `[a-zA-Z0-9_-]`，所以模型侧用 `domain__action`，事件与审计用契约原名。
 */
import { createDeps } from './deps.mjs';
import { ToolError, validateArgs, truncateForAudit } from './util.mjs';
import { createCatalogTools } from './catalog.mjs';
import { createInventoryTools } from './inventory.mjs';
import { createDemandTools } from './demand.mjs';
import { createSafetyTools } from './safety.mjs';
import { createSuggestionTools } from './suggestion.mjs';
import { createPlanTools } from './plan.mjs';
import { createOrderTools } from './order.mjs';
import { createAuditTools } from './audit.mjs';
import { createScheduleTools } from './schedule.mjs';
import { createAssumptionTools } from './assumption.mjs';
import { createWorkbenchTools } from './workbench.mjs';

export const DEFAULT_TOOL_TIMEOUT_MS = 20000;
/** 允许出现在 error.code 里的错误码（域错误 + 运行时预算错误） */
const KNOWN_ERROR_CODES = new Set([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'DATA_MISSING',
  'STALE_DATA',
  'APPROVAL_REQUIRED',
  'CONFLICT',
  'UPSTREAM_LLM_ERROR',
  'INTERNAL',
  'TOOL_TIMEOUT',
  'TOOL_CALL_BUDGET_EXCEEDED',
  'MAX_STEPS_EXCEEDED',
  'TURN_BUDGET_EXCEEDED',
]);

/** 契约工具名 → OpenAI function name（点号不合法） */
export function toModelName(name) {
  return String(name).replace(/\./g, '__');
}
/** OpenAI function name → 契约工具名 */
export function toCanonicalName(name) {
  return String(name).replace(/__/g, '.');
}

function errorFrom(err) {
  const code = KNOWN_ERROR_CODES.has(err?.code) ? err.code : 'INTERNAL';
  const message = err instanceof Error ? err.message : String(err);
  const error = { code, message };
  if (err?.hint) error.hint = err.hint;
  if (err?.details !== undefined) error.details = err.details;
  return error;
}

/**
 * @param {{db?: unknown, domain?: object, repository?: object, queries?: object|null,
 *          deps?: {ensure: Function}, clock?: () => number, limits?: object,
 *          extraTools?: Array<object>}} [opts]
 */
export function createToolRegistry(opts = {}) {
  const db = opts.db ?? null;
  const clock = opts.clock ?? (() => Date.now());
  const deps = opts.deps ?? createDeps({ domain: opts.domain, repository: opts.repository, queries: opts.queries });
  const limits = { toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS, ...(opts.limits ?? {}) };

  const builtin = [
    ...createCatalogTools(),
    ...createInventoryTools(),
    ...createDemandTools(),
    ...createSafetyTools(),
    ...createSuggestionTools(),
    ...createPlanTools(),
    ...createOrderTools(),
    ...createAuditTools(),
    ...createScheduleTools(),
    ...createWorkbenchTools(),
    ...createAssumptionTools(),
  ];
  const all = [...builtin, ...(opts.extraTools ?? [])];

  /** @type {Map<string, object>} */
  const byCanonical = new Map();
  /** @type {Map<string, object>} */
  const byModelName = new Map();
  for (const def of all) {
    if (!def?.name || typeof def.execute !== 'function') {
      throw new Error(`工具定义非法：${JSON.stringify(def?.name ?? def)}`);
    }
    if (byCanonical.has(def.name)) throw new Error(`工具名重复：${def.name}`);
    byCanonical.set(def.name, def);
    byModelName.set(toModelName(def.name), def);
  }

  async function resolveDeps() {
    return deps.ensure();
  }

  /**
   * 执行一次工具调用（含审计与超时）。
   * @param {string} name 契约名或模型名
   * @param {object|string} rawArgs 对象或 JSON 字符串
   * @param {{sessionId?: string|null, step?: number, callId?: string, signal?: AbortSignal,
   *          actor?: 'agent'|'scheduler'|'human'}} [ctx]
   */
  async function execute(name, rawArgs, ctx = {}) {
    const def = byCanonical.get(name) ?? byModelName.get(name);
    const startedAt = clock();
    const actor = ctx.actor ?? 'agent';
    const toolName = def?.name ?? String(name);

    // ---- 入参解析（JSON 字符串是模型的常见输出）----
    let args = rawArgs ?? {};
    let parseFailed = false;
    if (typeof args === 'string') {
      try {
        args = args.trim() ? JSON.parse(args) : {};
      } catch {
        parseFailed = true;
        args = {};
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      parseFailed = true;
      args = {};
    }

    if (!def) {
      return {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `未知工具：${name}`,
          hint: '只能调用 tools 列表里的工具',
        },
        meta: { tool: String(name), duration_ms: clock() - startedAt, provenance: 'documented' },
      };
    }

    const { repository } = await resolveDeps();

    // ---- 审计 #1：tool_call（入参 / dry / 截断 2KB）----
    await writeAudit(repository, ctx, {
      session_id: ctx.sessionId ?? null,
      actor,
      kind: 'tool_call',
      tool: toolName,
      ok: true,
      duration_ms: 0,
      provenance: def.provenance ?? 'documented',
      payload: {
        dry: def.write !== true,
        call_id: ctx.callId ?? null,
        step: ctx.step ?? null,
        args: truncateForAudit(args ?? rawArgs),
      },
    });

    let data;
    let error = null;
    if (parseFailed) {
      error = { code: 'VALIDATION_ERROR', message: `工具 ${toolName} 的参数不是合法 JSON 对象`, hint: '请传入 JSON 对象' };
    } else {
      try {
        validateArgs(toolName, args, def.parameters);
        const execCtx = {
          db,
          sessionId: ctx.sessionId ?? null,
          step: ctx.step ?? null,
          callId: ctx.callId ?? null,
          actor,
          deps: await resolveDeps(),
          registry: api,
          clock,
        };
        data = await runWithTimeout(def, args, execCtx, limits.toolTimeoutMs, ctx.signal);
      } catch (err) {
        error = errorFrom(err);
      }
    }

    const durationMs = clock() - startedAt;
    const duration = Math.max(0, Math.round(durationMs));

    // ---- 审计 #2：tool_result（结果 / 错误 / 耗时）----
    await writeAudit(repository, ctx, {
      session_id: ctx.sessionId ?? null,
      actor,
      kind: 'tool_result',
      tool: toolName,
      ok: !error,
      duration_ms: duration,
      provenance: def.provenance ?? 'documented',
      payload: {
        dry: def.write !== true,
        call_id: ctx.callId ?? null,
        step: ctx.step ?? null,
        ...(error ? { error } : { result: truncateForAudit(data) }),
      },
    });

    if (error) {
      return {
        ok: false,
        error,
        meta: { tool: toolName, duration_ms: duration, provenance: def.provenance ?? 'documented' },
      };
    }

    // ---- meta：溯源三件套 + artifact / approval 提取 ----
    const extra = typeof def.meta === 'function' ? def.meta(data, ctx) ?? {} : {};
    const meta = {
      tool: toolName,
      duration_ms: duration,
      provenance: extra.provenance ?? def.provenance ?? 'documented',
      assumptions: extra.assumptions ?? [],
      as_of: extra.as_of ?? null,
      ...(extra.summary ? { summary: extra.summary } : {}),
      ...(extra.artifacts ? { artifacts: extra.artifacts } : {}),
      ...(extra.approval ? { approval: extra.approval } : {}),
      ...(extra.meta ?? {}),
    };
    return { ok: true, data, meta };
  }

  async function runWithTimeout(def, args, execCtx, timeoutMs, externalSignal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ToolError('TOOL_TIMEOUT', `工具 ${def.name} 超过 ${timeoutMs}ms 未返回，已中止`, {
          hint: '可减少批量条数或稍后重试',
        }));
      }, Math.max(1, timeoutMs));
    });
    try {
      return await Promise.race([def.execute(args, { ...execCtx, signal: controller.signal }), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener?.('abort', onAbort);
    }
  }

  async function writeAudit(repository, ctx, event) {
    // 审计是硬要求：数据层未提供 appendAudit 时让错误显式暴露（避免"看起来有审计其实没有"）
    if (typeof repository?.appendAudit !== 'function') {
      const err = new Error('数据层缺少 appendAudit，无法写审计');
      err.code = 'INTERNAL';
      throw err;
    }
    return repository.appendAudit(db, event);
  }

  const api = {
    /** 契约名列表（含 extraTools） */
    names() {
      return [...byCanonical.keys()];
    },
    /** 工具定义（只读快照） */
    definitions() {
      return [...byCanonical.values()];
    },
    /** OpenAI tools schema（名字用 domain__action） */
    toModelTools() {
      return [...byCanonical.values()].map((def) => ({
        type: 'function',
        function: {
          name: toModelName(def.name),
          description: def.description,
          parameters: def.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
        },
      }));
    },
    /** 解析模型返回的名字到契约名（未知返回 null） */
    canonicalName(name) {
      const def = byCanonical.get(name) ?? byModelName.get(name);
      return def?.name ?? null;
    },
    get(name) {
      return byCanonical.get(name) ?? byModelName.get(name) ?? null;
    },
    execute,
    db,
    deps,
    limits,
    clock,
  };
  return api;
}
