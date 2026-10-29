/**
 * router.mjs — HTTP 路由表（零框架，node:http）
 * ---------------------------------------------------------------------------
 * 设计纪律（契约 §3 / §6）：
 *  1) **路由不做业务计算**：只做「校验入参 → 调仓储/读模型/Agent → 包统一信封」；
 *     公式、KPI、建议行一律由 `server/domain` 与 `server/data/queries.mjs` 产出。
 *  2) 依赖注入：`deps = { repo, queries, domain, agent: { runtime, scheduler, tools }, errorMapper }`；
 *     缺某一层 → `INTERNAL + DEPENDENCY_MISSING`（并行开发/半成品部署不崩进程，也不静默算错）。
 *  3) 入参校验一律走 `validate.mjs`，错误 details 形如 `{ fields: [{ field, message }] }`。
 *  4) 唯一会「自己写响应」的路径是 SSE（`POST /api/sessions/:id/messages`）。
 *
 * 注：本文件在 v2 集成期被重写（原并行产出发生中文双重编码损坏，字符串收尾引号被吃掉）。
 *     行为以 `docs/contracts.md` §6 与 `test/api/*.test.mjs` 为准。
 */

import { openSse } from './sse.mjs';
import * as V from './validate.mjs';
import {
  MAX_BODY_BYTES,
  applyCommonHeaders,
  conflict,
  dependencyMissing,
  internalError,
  notFound,
  payloadTooLarge,
  redact,
  sendError,
  sendOk,
} from './respond.mjs';

export const SERVICE_NAME = 'replenishment-agent';

const ORDER_KINDS = Object.freeze(['purchase', 'apply']);
const APPROVAL_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'all']);
const SCOPES = Object.freeze(['store', 'headquarters']);
const SAFETY_MODES = Object.freeze(['fixed', 'dynamic']);
const DEFAULT_PLAN_TYPES = Object.freeze(['avg_daily', 'stock_upper', 'custom', 'sigma']);
const DRAFT_STATUSES = Object.freeze(['draft', 'approved', 'rejected', 'committed', 'all']);
const RISK_LEVELS = Object.freeze(['缺货', '紧急', '建议', '滞销', '充足']);
const WORKBENCH_SORTS = Object.freeze(['risk_priority', 'cover_days', 'amount', 'suggest_num', 'inventory_capital', 'avg_daily_sales']);
const SORT_ORDERS = Object.freeze(['asc', 'desc']);

/** 方案配置的入参上界（域层会再裁剪一次；这里只挡明显非法值） */
const PLAN_CONFIG_BOUNDS = Object.freeze({
  purchase_cycle_days: { min: 1, max: 90, int: true },
  coverage_days: { min: 1, max: 180, int: true },
  lead_time_days: { min: 1, max: 120, int: true },
  forecast_window: { min: 3, max: 90, int: true },
  safety_days: { min: 0, max: 60, int: false },
  service_level: { min: 0.5, max: 0.999, int: false },
  trend_damping: { min: 0, max: 1, int: false },
  weekend_coefficient: { min: 0.1, max: 5, int: false },
  holiday_coefficient: { min: 0.1, max: 5, int: false },
  moq: { min: 1, max: 10000, int: true },
  pack_size: { min: 1, max: 1000, int: true },
  slow_moving_days: { min: 7, max: 180, int: true },
  slow_moving_cover_days: { min: 30, max: 999, int: true },
  min_daily_sales: { min: 0, max: 100, int: false },
  urgent_cover_days: { min: 0, max: 60, int: true },
});

const PLAN_CONFIG_FLAGS = Object.freeze([
  'coefficient_enabled',
  'weekend_coefficient_enabled',
  'holiday_coefficient_enabled',
  'seasonality',
]);

const SAFETY_BOUNDS = Object.freeze({
  lower_fixed: { min: 0, max: 1_000_000, int: true },
  upper_fixed: { min: 0, max: 10_000_000, int: true },
  min_sellable_days: { min: 0, max: 180, int: true },
  max_sellable_days: { min: 1, max: 365, int: true },
});

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

/**
 * 固定时区偏移下的「今天」（`+08:00` → 东八区日期）。
 * 不用 `toLocaleDateString`，避免运行环境时区影响结果。
 */
export function todayInTimezone(tzOffset = '+08:00') {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(String(tzOffset ?? ''));
  const minutes = match
    ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
    : 0;
  const shifted = new Date(Date.now() + minutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 小工具（视图适配 / 请求体）
// ---------------------------------------------------------------------------

/** 统一成数组：仓储可能返回裸数组或 `{ key: [...] }` */
function asList(value, key) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value[key])) return value[key];
  return [];
}

/** 视图适配：仓储用 `id`，契约用 `<entity>_id` */
function withId(entity, aliasKey) {
  if (!entity || typeof entity !== 'object') return entity;
  const id = entity[aliasKey] ?? entity.id ?? null;
  return { ...entity, [aliasKey]: id };
}

function normalizeSession(session) {
  if (!session) return null;
  return {
    ...withId(session, 'session_id'),
    title: session.title ?? '补货会话',
    created_at: session.created_at ?? null,
    updated_at: session.updated_at ?? session.created_at ?? null,
  };
}

function normalizeMessage(row) {
  if (!row) return null;
  return {
    message_id: row.message_id ?? row.id ?? null,
    seq: row.seq ?? null,
    role: row.role ?? 'assistant',
    content: row.content ?? null,
    created_at: row.created_at ?? null,
  };
}

function normalizeArtifact(row) {
  if (!row) return null;
  return {
    ...withId(row, 'artifact_id'),
    kind: row.kind ?? 'unknown',
    title: row.title ?? '',
    content: row.content ?? row.content_json ?? null,
    created_at: row.created_at ?? null,
  };
}

function normalizeDraft(draft) {
  if (!draft) return null;
  return {
    ...withId(draft, 'draft_id'),
    status: draft.status ?? 'draft',
    kind: draft.kind ?? 'purchase',
    items: Array.isArray(draft.items) ? draft.items : [],
    total_qty: draft.total_qty ?? null,
    total_amount: draft.total_amount ?? null,
  };
}

function normalizeOrder(order) {
  if (!order) return null;
  return {
    ...withId(order, 'order_id'),
    status: order.status ?? 'committed',
    kind: order.kind ?? 'purchase',
    items: Array.isArray(order.items) ? order.items : [],
  };
}

function normalizePlan(plan) {
  if (!plan) return null;
  return { ...withId(plan, 'plan_id'), config: plan.config ?? {} };
}

function normalizeApproval(approval) {
  if (!approval) return null;
  return { ...withId(approval, 'approval_id'), status: approval.status ?? 'pending' };
}

function normalizeSchedule(schedule) {
  if (!schedule) return null;
  return { ...withId(schedule, 'schedule_id'), enabled: schedule.enabled !== false };
}

/** 读取原始请求体（2MB 上限；超限 → 413 + VALIDATION_ERROR） */
async function readRaw(req) {
  const chunks = [];
  let size = 0;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settle(reject, payloadTooLarge(MAX_BODY_BYTES));
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(resolve, Buffer.concat(chunks).toString('utf8'));
    const onError = (err) => settle(reject, err);
    const onAborted = () =>
      settle(
        reject,
        Object.assign(new Error('请求体传输中断'), { code: 'VALIDATION_ERROR', status: 400 }),
      );
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/** 读取并解析 JSON 请求体（空体 → {}） */
async function readJson(req) {
  const raw = await readRaw(req);
  return V.parseJsonBody(raw);
}

/** 校验方案配置（字段名带 `config.` 前缀，便于前端定位） */
function validatePlanConfig(raw) {
  const config = V.assertObject(raw ?? {}, 'config', { required: false, default: {} });
  const out = { ...config };
  for (const [key, bounds] of Object.entries(PLAN_CONFIG_BOUNDS)) {
    if (config[key] === undefined) continue;
    out[key] = bounds.int
      ? V.assertInt(config[key], `config.${key}`, { min: bounds.min, max: bounds.max })
      : V.assertNumber(config[key], `config.${key}`, { min: bounds.min, max: bounds.max });
  }
  for (const key of PLAN_CONFIG_FLAGS) {
    if (config[key] === undefined) continue;
    out[key] = V.assertBoolean(config[key], `config.${key}`, {}) ? 1 : 0;
  }
  return out;
}

/** 校验库存预警配置（扁平） */
function validateSafetyPatch(body) {
  const patch = {};
  if (body.mode !== undefined) {
    patch.mode = V.assertEnum(body.mode, 'mode', SAFETY_MODES, { required: true });
  }
  for (const [key, bounds] of Object.entries(SAFETY_BOUNDS)) {
    if (body[key] === undefined) continue;
    patch[key] = bounds.int
      ? V.assertInt(body[key], key, { min: bounds.min, max: bounds.max })
      : V.assertNumber(body[key], key, { min: bounds.min, max: bounds.max });
  }
  if (body.store_id !== undefined) patch.store_id = V.assertId(body.store_id, 'store_id');
  return patch;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   config?: object, db?: unknown, provider?: object, version?: string,
 *   deps?: { repo?: object, queries?: object, domain?: object, agent?: object },
 *   providerInfo?: { provider?: string, model?: string }, heartbeatMs?: number, staticDir?: string|null
 * }} [options]
 */
export function createRouter(options = {}) {
  const config = options.config ?? {};
  const db = options.db;
  const providerInfo = options.providerInfo ?? {};
  const version = options.version ?? '0.0.0';
  const heartbeatMs = options.heartbeatMs;
  const deps = options.deps ?? {};

  // ---- 依赖门禁：缺层时给明确错误，而不是 undefined 崩溃 ----
  const repo = () => {
    if (!deps.repo) throw dependencyMissing('server/data/repository.mjs');
    return deps.repo;
  };
  const queries = () => {
    if (!deps.queries) throw dependencyMissing('server/data/queries.mjs');
    return deps.queries;
  };
  const domain = () => {
    if (!deps.domain) throw dependencyMissing('server/domain/index.mjs');
    return deps.domain;
  };
  const runtime = () => {
    const rt = deps.agent?.runtime;
    if (!rt || typeof rt.run !== 'function') throw dependencyMissing('server/agent/runtime.mjs');
    return rt;
  };
  const scheduler = () => {
    const sch = deps.agent?.scheduler;
    if (!sch) throw dependencyMissing('server/agent/scheduler.mjs');
    return sch;
  };
  const provider = () => options.provider ?? deps.provider ?? null;

  // ---- 工作台读模型（增强层；注入优先，便于测试 stub） ----
  let workbenchModule = null;
  async function workbenchApi() {
    if (deps.workbench && typeof deps.workbench.buildWorkbench === 'function') return deps.workbench;
    const q = deps.queries;
    if (q && typeof q.buildWorkbench === 'function') return q;
    workbenchModule ??= await import('../data/workbench.mjs');
    return workbenchModule;
  }

  async function audit(event) {
    try {
      const r = repo();
      if (typeof r.appendAudit !== 'function') return;
      await r.appendAudit(db, event);
    } catch {
      /* 审计失败不阻断请求 */
    }
  }

  function today() {
    try {
      const meta = repo().getMeta?.(db);
      if (meta?.today) return String(meta.today);
    } catch {
      /* fallthrough */
    }
    return todayInTimezone(config.tzOffset);
  }

  function allowedPlanTypes() {
    const d = domain();
    if (Array.isArray(d.PLAN_TYPE_ORDER)) return [...d.PLAN_TYPE_ORDER];
    if (Array.isArray(d.PLAN_TYPES)) return [...d.PLAN_TYPES];
    return [...DEFAULT_PLAN_TYPES];
  }

  // -------------------------------------------------------------------------
  // handlers
  // -------------------------------------------------------------------------

  const handlers = {
    /* ------------------------------ 健康/元数据 ------------------------------ */
    async health() {
      let dbOk = true;
      try {
        repo().getMeta?.(db);
      } catch {
        dbOk = false;
      }
      return {
        status: dbOk ? 'ok' : 'degraded',
        service: SERVICE_NAME,
        version,
        provider: providerInfo.provider ?? provider()?.name ?? 'mock',
        model: providerInfo.model ?? provider()?.model ?? 'unknown',
        today: today(),
        node: process.version,
        uptime_s: Math.round(process.uptime()),
      };
    },

    async meta() {
      const meta = (await repo().getMeta?.(db)) ?? {};
      return {
        ...meta,
        today: meta.today ?? today(),
        stores: asList(meta.stores, 'stores'),
        suppliers: asList(meta.suppliers, 'suppliers'),
        categories: asList(meta.categories, 'categories'),
        plans: asList(meta.plans, 'plans').map(normalizePlan),
        counts: meta.counts ?? repo().getSkuCounts?.(db) ?? {},
      };
    },

    async assumptions() {
      const list = domain().ASSUMPTIONS ?? [];
      return { assumptions: Array.isArray(list) ? [...list] : [] };
    },

    /* -------------------------------- 会话 --------------------------------- */
    async createSession({ body }) {
      const title = V.assertTitle(body.title);
      const created = await repo().createSession(db, { title });
      const session = normalizeSession(created);
      return { __status: 201, session_id: session?.session_id ?? null, session };
    },

    async listSessions() {
      const rows = asList(await repo().listSessions(db), 'sessions');
      return { sessions: rows.map(normalizeSession) };
    },

    async getSession({ params }) {
      const r = repo();
      const session = await r.getSession(db, params.id);
      if (!session) throw notFound(`会话 ${params.id} 不存在`);
      const messages = asList(await r.listMessages(db, params.id), 'messages').map(normalizeMessage);
      const artifacts = asList(await r.listArtifacts(db, params.id), 'artifacts').map(normalizeArtifact);
      return { session: normalizeSession(session), messages, artifacts };
    },

    async deleteSession({ params }) {
      const r = repo();
      const session = await r.getSession(db, params.id);
      if (!session) throw notFound(`会话 ${params.id} 不存在`);
      await r.deleteSession(db, params.id);
      await audit({ session_id: params.id, actor: 'human', kind: 'session_deleted', ok: true, payload: {} });
      return { deleted: true, session_id: params.id };
    },

    /* -------------------------------- 审批 --------------------------------- */
    async resolveApproval({ params, body }) {
      // 先校验决策合法性（非法决策 → 400，即使审批已处理）
      const decision = V.assertDecision(body.decision);
      const note = V.assertString(body.note, 'note', { required: false, max: 500, default: '' });
      const r = repo();
      const approval = await r.getApproval(db, params.approval_id);
      if (!approval) throw notFound(`审批 ${params.approval_id} 不存在`);
      if (approval.session_id && params.id && approval.session_id !== params.id) {
        throw notFound(`审批 ${params.approval_id} 不存在于会话 ${params.id}`);
      }
      if ((approval.status ?? 'pending') !== 'pending') {
        throw conflict(`审批 ${params.approval_id} 已处理（${approval.status}）`);
      }
      const updated = await r.resolveApproval(db, params.approval_id, {
        decision,
        note,
        operator: 'human',
      });
      await audit({
        session_id: params.id ?? approval.session_id ?? null,
        actor: 'human',
        kind: 'approval_resolved',
        tool: 'approvals',
        ok: true,
        payload: { approval_id: params.approval_id, decision, note, draft_id: approval.draft_id ?? null },
      });
      return {
        approval: normalizeApproval(
          updated ?? { ...approval, status: decision === 'approve' ? 'approved' : 'rejected' },
        ),
      };
    },

    async listApprovals({ query }) {
      const status = V.assertEnum(query.get('status'), 'status', APPROVAL_STATUSES, {
        required: false,
        default: undefined,
      });
      const sessionId = query.get('session_id')
        ? V.assertId(query.get('session_id'), 'session_id')
        : undefined;
      const rows = asList(
        await repo().listApprovals(db, {
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(status && status !== 'all' ? { status } : {}),
          limit: V.assertLimit(query.get('limit'), 'limit', { default: 50, max: 200 }),
        }),
        'approvals',
      );
      return { approvals: rows.map(normalizeApproval) };
    },

    /* -------------------------------- 方案 --------------------------------- */
    async listPlans() {
      const plans = asList(await repo().listPlans(db), 'plans');
      return { plans: plans.map(normalizePlan) };
    },

    async getPlan({ params }) {
      const plan = await repo().getPlan(db, params.id);
      if (!plan) throw notFound(`方案 ${params.id} 不存在`);
      return normalizePlan(plan);
    },

    async createPlan({ body }) {
      const planName = V.assertString(body.plan_name, 'plan_name', { required: true, min: 1, max: 60 });
      const planType = V.assertEnum(body.plan_type, 'plan_type', allowedPlanTypes(), { required: true });
      const config = { ...validatePlanConfig(body.config), plan_type: planType };
      const created = await repo().createPlan(db, {
        plan_name: planName,
        plan_type: planType,
        config,
        creator: V.assertString(body.creator, 'creator', { required: false, max: 40, default: '当前用户' }),
        remark: V.assertString(body.remark, 'remark', { required: false, max: 200, default: '' }),
      });
      await audit({
        actor: 'human',
        kind: 'plan_created',
        tool: 'plans',
        ok: true,
        payload: { plan_id: normalizePlan(created)?.plan_id },
      });
      return { __status: 201, plan: normalizePlan(created) };
    },

    async updatePlan({ params, body }) {
      const plan = await repo().getPlan(db, params.id);
      if (!plan) throw notFound(`方案 ${params.id} 不存在`);
      const patch = {};
      if (body.plan_name !== undefined) {
        patch.plan_name = V.assertString(body.plan_name, 'plan_name', { required: true, min: 1, max: 60 });
      }
      if (body.plan_type !== undefined) {
        const nextType = V.assertEnum(body.plan_type, 'plan_type', allowedPlanTypes(), { required: true });
        if (plan.is_system && nextType !== plan.plan_type) {
          throw conflict('系统默认方案只允许修改参数，不允许改方案类型', { plan_id: plan.plan_id });
        }
        patch.plan_type = nextType;
      }
      if (body.remark !== undefined) {
        patch.remark = V.assertString(body.remark, 'remark', { required: false, max: 200, default: '' });
      }
      if (body.config !== undefined) {
        patch.config = { ...(plan.config ?? {}), ...validatePlanConfig(body.config) };
      }
      const updated = await repo().updatePlan(db, params.id, patch);
      await audit({ actor: 'human', kind: 'plan_updated', tool: 'plans', ok: true, payload: { plan_id: params.id } });
      return { plan: normalizePlan(updated) };
    },

    async deletePlan({ params }) {
      const plan = await repo().getPlan(db, params.id);
      if (!plan) throw notFound(`方案 ${params.id} 不存在`);
      if (plan.is_system) throw conflict('系统默认方案可修改但不可删除');
      await repo().deletePlan(db, params.id);
      await audit({ actor: 'human', kind: 'plan_deleted', tool: 'plans', ok: true, payload: { plan_id: params.id } });
      return { deleted: true, plan_id: params.id };
    },

    /* -------------------------------- 建议 --------------------------------- */
    async suggestions({ query }) {
      const pageInfo = V.assertPagination(query);
      const options = {
        ...(query.get('plan_id') ? { plan_id: V.assertId(query.get('plan_id'), 'plan_id') } : {}),
        ...(query.get('store_id') ? { store_id: V.assertId(query.get('store_id'), 'store_id') } : {}),
        ...(query.get('category')
          ? { category: V.assertString(query.get('category'), 'category', { max: 40 }) }
          : {}),
        ...(query.get('keyword')
          ? { keyword: V.assertString(query.get('keyword'), 'keyword', { max: 60 }) }
          : {}),
        ...(query.get('as_of') ? { as_of: V.assertDate(query.get('as_of'), 'as_of') } : {}),
        ...(query.get('expected_arrival')
          ? { expected_arrival: V.assertDate(query.get('expected_arrival'), 'expected_arrival') }
          : {}),
        ...(query.get('scope')
          ? { scope: V.assertEnum(query.get('scope'), 'scope', SCOPES, { default: 'store' }) }
          : {}),
        only_low:
          query.get('only_low') === null
            ? false
            : V.assertBoolean(query.get('only_low'), 'only_low', {}),
        page: pageInfo.page,
        page_size: pageInfo.page_size,
      };
      return await queries().buildSuggestions(db, options);
    },

    /* ------------------------- 决策工作台（增强层） ------------------------ */
    async workbench({ query }) {
      const pageInfo = V.assertPagination(query);
      const asOf = query.get('as_of') ? V.assertDate(query.get('as_of'), 'as_of') : undefined;
      const options = {
        ...(query.get('plan_id') ? { plan_id: V.assertId(query.get('plan_id'), 'plan_id') } : {}),
        ...(query.get('store_id') ? { store_id: V.assertId(query.get('store_id'), 'store_id') } : {}),
        ...(query.get('category')
          ? { category: V.assertString(query.get('category'), 'category', { max: 40 }) }
          : {}),
        ...(query.get('keyword')
          ? { keyword: V.assertString(query.get('keyword'), 'keyword', { max: 60 }) }
          : {}),
        ...(asOf ? { as_of: asOf } : {}),
        ...(query.get('risk') ? { risk: V.assertEnum(query.get('risk'), 'risk', RISK_LEVELS) } : {}),
        ...(query.get('sort') ? { sort: V.assertEnum(query.get('sort'), 'sort', WORKBENCH_SORTS) } : {}),
        ...(query.get('order') ? { order: V.assertEnum(query.get('order'), 'order', SORT_ORDERS) } : {}),
        ...(query.get('scope')
          ? { scope: V.assertEnum(query.get('scope'), 'scope', SCOPES, { default: 'store' }) }
          : {}),
        page: pageInfo.page,
        page_size: pageInfo.page_size,
      };
      const api = await workbenchApi();
      return await api.buildWorkbench(db, options);
    },

    async skuDetail({ params, query }) {
      const asOf = query.get('as_of') ? V.assertDate(query.get('as_of'), 'as_of') : undefined;
      const scope = query.get('scope')
        ? V.assertEnum(query.get('scope'), 'scope', SCOPES, { default: 'store' })
        : undefined;
      const detail = await queries().getSkuDetail(db, params.code, {
        ...(asOf ? { as_of: asOf } : {}),
        ...(scope ? { scope } : {}),
      });
      if (!detail) throw notFound(`SKU ${params.code} 不存在`);
      // 决策视图（增强层：风险分级/可售天数/断货日）；失败不影响主详情
      let decision = null;
      try {
        const wb = await workbenchApi();
        if (typeof wb.buildSkuDecision === 'function') {
          decision = wb.buildSkuDecision(db, params.code, {
            ...(asOf ? { asOf } : {}),
            ...(query.get('plan_id') ? { plan_id: query.get('plan_id') } : {}),
          });
        }
      } catch {
        decision = null;
      }
      // 视图适配：读模型可能给 `series/sales_rows`，契约要 `sales`
      return { ...detail, sales: detail.sales ?? detail.sales_rows ?? [], decision };
    },

    /* -------------------------------- 库存 --------------------------------- */
    async inventory({ query }) {
      const { page, page_size: pageSize } = V.assertPagination(query);
      const storeId = query.get('store_id') ? V.assertId(query.get('store_id'), 'store_id') : undefined;
      const category = query.get('category')
        ? V.assertString(query.get('category'), 'category', { max: 40 })
        : undefined;
      const keyword = query.get('keyword')
        ? V.assertString(query.get('keyword'), 'keyword', { max: 60 })
        : undefined;
      const r = repo();
      const skus = asList(
        await r.listSkus(db, {
          ...(storeId ? { store_id: storeId } : {}),
          ...(category ? { category } : {}),
          ...(keyword ? { keyword } : {}),
        }),
        'skus',
      );
      const total = skus.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const current = Math.min(page, totalPages);
      const start = (current - 1) * pageSize;
      const rows = [];
      for (const sku of skus.slice(start, start + pageSize)) {
        const skuId = sku.sku_id ?? sku.id;
        const inventory = skuId !== undefined && skuId !== null ? await r.getInventory(db, skuId) : null;
        const onHand = inventory?.on_hand ?? null;
        const locked = inventory?.locked ?? inventory?.allocated ?? null;
        // 视图适配：仓储列名（code/name）→ 契约列名（sku_code/product_name）
        rows.push({
          sku_id: skuId,
          sku_code: sku.sku_code ?? sku.code,
          sku_no: sku.sku_no ?? '',
          product_name: sku.product_name ?? sku.name ?? '',
          spec: sku.spec ?? '',
          unit: sku.unit ?? '',
          category: sku.category ?? '',
          store_id: sku.store_id ?? null,
          store_name: sku.store_name ?? '',
          supplier_code: sku.supplier_code ?? '',
          supplier_name: sku.supplier_name ?? '',
          cost_price: sku.cost_price ?? null,
          retail_price: sku.retail_price ?? null,
          tax_rate: sku.tax_rate ?? null,
          status: sku.status ?? '',
          on_hand: onHand,
          locked,
          sellable:
            inventory?.sellable ??
            (Number.isFinite(onHand) && Number.isFinite(locked) ? onHand - locked : null),
          in_transit: inventory?.in_transit ?? null,
          plan_stock: inventory?.plan_stock ?? null,
          snapshot_date: inventory?.snapshot_date ?? null,
          staleness_days: inventory?.staleness_days ?? null,
        });
      }
      return { rows, total, page: current, page_size: pageSize, total_pages: totalPages };
    },

    async getSafetyStock({ query }) {
      const storeId = query.get('store_id') ? V.assertId(query.get('store_id'), 'store_id') : undefined;
      const cfg = await repo().getSafetyConfig(db, storeId ? { store_id: storeId } : {});
      return cfg ?? {};
    },

    async updateSafetyStock({ body }) {
      const patch = validateSafetyPatch(V.assertObject(body ?? {}, 'body', { required: true }));
      const saved = await repo().saveSafetyConfig(db, patch);
      await audit({ actor: 'human', kind: 'safety_config_updated', tool: 'safety-stock', ok: true, payload: patch });
      return saved ?? (await repo().getSafetyConfig(db, {})) ?? {};
    },

    /* ------------------------------- 节假日 -------------------------------- */
    async listHolidays() {
      const rows = asList(await repo().listHolidays(db), 'holidays');
      const details = rows.map((row) =>
        typeof row === 'string' ? { date: row, name: '' } : { date: row.date, name: row.name ?? '' },
      );
      // `holidays` 保持「日期字符串数组」（契约/测试口径），名次放 `holiday_details` 给前端
      return { holidays: details.map((row) => row.date), holiday_details: details };
    },

    async addHoliday({ body }) {
      const date = V.assertDate(body.date, 'date', { required: true });
      const name = V.assertString(body.name, 'name', { required: false, max: 60, default: '' });
      const saved = await repo().addHoliday(db, { date, name });
      await audit({ actor: 'human', kind: 'holiday_added', ok: true, payload: { date, name } });
      const holiday =
        saved && typeof saved === 'object' && !Array.isArray(saved)
          ? { date: saved.date ?? date, name: saved.name ?? name }
          : { date, name };
      return { __status: 201, holiday };
    },

    async removeHoliday({ params, query }) {
      const raw = params.date ?? query.get('date');
      const date = V.assertDate(raw, 'date', { required: true });
      await repo().removeHoliday(db, date);
      await audit({ actor: 'human', kind: 'holiday_removed', ok: true, payload: { date } });
      return { deleted: true, date };
    },

    /* ------------------------------ 草稿/订单 ------------------------------ */
    async listDrafts({ query }) {
      const status = V.assertEnum(query.get('status'), 'status', DRAFT_STATUSES, {
        required: false,
        default: undefined,
      });
      const drafts = asList(
        await repo().listDrafts(db, status && status !== 'all' ? { status } : {}),
        'drafts',
      );
      return { drafts: drafts.map(normalizeDraft) };
    },

    async getDraft({ params }) {
      const draft = await repo().getDraft(db, params.id);
      if (!draft) throw notFound(`草稿 ${params.id} 不存在`);
      return { draft: normalizeDraft(draft) };
    },

    async createDraft({ body }) {
      const kind = V.assertEnum(body.kind, 'kind', ORDER_KINDS, { required: false, default: 'purchase' });
      const items = V.assertArray(body.items, 'items', {
        required: true,
        min: 1,
        max: 200,
        item: (entry, index) => {
          const item = V.assertObject(entry, `items[${index}]`, { required: true });
          const skuCode = V.assertString(item.sku_code ?? item.sku_no, `items[${index}].sku_code`, {
            required: true,
            max: 64,
          });
          const applyNum = V.assertInt(item.apply_num ?? item.suggest_num, `items[${index}].apply_num`, {
            required: true,
            min: 0,
            max: 1_000_000,
          });
          return { sku_code: skuCode, apply_num: applyNum };
        },
      });
      const expectedArrival = body.expected_arrival
        ? V.assertDate(body.expected_arrival, 'expected_arrival')
        : undefined;
      const draft = await repo().createOrderDraft(db, {
        kind,
        items,
        expected_arrival: expectedArrival,
        remark: V.assertString(body.remark, 'remark', { required: false, max: 500, default: '' }),
        session_id: V.assertId(body.session_id, 'session_id', { required: false }),
        created_by: V.assertString(body.created_by, 'created_by', { required: false, max: 64, default: 'human' }),
      });
      await audit({
        session_id: body.session_id ?? null,
        actor: 'human',
        kind: 'draft_created',
        tool: 'drafts',
        ok: true,
        payload: { draft_id: normalizeDraft(draft)?.draft_id, kind, item_count: items.length },
      });
      return { __status: 201, draft: normalizeDraft(draft) };
    },

    async commitDraft({ params, body }) {
      const r = repo();
      const draft = await r.getDraft(db, params.id);
      if (!draft) throw notFound(`草稿 ${params.id} 不存在`);

      // 幂等：已提交 → 直接回原单（不要求再带审批）
      if (draft.status === 'committed' && draft.committed_order_id) {
        const orders = asList(await r.listOrders(db, { limit: 200 }), 'orders');
        const existing = orders.find(
          (order) =>
            order.id === draft.committed_order_id || order.order_id === draft.committed_order_id,
        );
        if (existing) return { order: normalizeOrder(existing), idempotent: true };
      }

      const approvalId = V.assertId(body.approval_id, 'approval_id', { required: true });
      const approval = await r.getApproval(db, approvalId);
      if (!approval) throw notFound(`审批 ${approvalId} 不存在`, { approval_id: approvalId });
      const approvalStatus = approval.status ?? 'pending';
      if (approvalStatus !== 'approved') {
        throw Object.assign(new Error(`草稿提交需要已通过的审批（当前 ${approvalStatus}）`), {
          code: 'APPROVAL_REQUIRED',
          details: { approval_id: approvalId, status: approvalStatus },
        });
      }

      const order = await r.commitDraft(db, params.id, { approval_id: approvalId, operator: 'human' });
      await audit({
        session_id: draft.session_id ?? null,
        actor: 'human',
        kind: 'draft_committed',
        tool: 'drafts',
        ok: true,
        payload: {
          draft_id: params.id,
          approval_id: approvalId,
          order_id: normalizeOrder(order)?.order_id,
        },
      });
      return { order: normalizeOrder(order), idempotent: false };
    },

    async listOrders({ query }) {
      const kind = V.assertEnum(query.get('kind'), 'kind', ORDER_KINDS, { required: false, default: undefined });
      const limit = V.assertLimit(query.get('limit'), 'limit', { default: 100, max: 500 });
      const orders = asList(await repo().listOrders(db, { ...(kind ? { kind } : {}), limit }), 'orders');
      return { orders: orders.map(normalizeOrder) };
    },

    /* -------------------------------- 审计 --------------------------------- */
    async audit({ query }) {
      const limit = V.assertLimit(query.get('limit'), 'limit', { default: 100, max: 500 });
      const events = asList(
        await repo().searchAudit(db, {
          ...(query.get('session_id') ? { session_id: V.assertId(query.get('session_id'), 'session_id') } : {}),
          ...(query.get('kind') ? { kind: V.assertString(query.get('kind'), 'kind', { max: 40 }) } : {}),
          limit,
        }),
        'events',
      );
      return { events };
    },

    /* -------------------------------- 调度 --------------------------------- */
    async listSchedules() {
      const rows = asList(await repo().listSchedules(db), 'schedules');
      return { schedules: rows.map(normalizeSchedule) };
    },

    async runSchedule({ params }) {
      const r = repo();
      const rows = asList(await r.listSchedules(db), 'schedules');
      const target = rows.find((item) => String(item?.id ?? item?.schedule_id) === String(params.id));
      if (!target) throw notFound(`定时任务 ${params.id} 不存在`, { schedule_id: params.id });
      const sch = scheduler();
      let result;
      if (typeof sch.triggerSchedule === 'function') {
        result = await sch.triggerSchedule({ scheduleId: params.id, db, runtime: runtime() });
      } else if (typeof sch.runScheduleOnce === 'function') {
        result = await sch.runScheduleOnce({ db, runtime: runtime(), schedule: target });
      } else {
        throw dependencyMissing('scheduler.triggerSchedule / runScheduleOnce');
      }
      if (typeof r.markScheduleRun === 'function') {
        await r.markScheduleRun(db, params.id, result);
      }
      await audit({
        actor: 'scheduler',
        kind: 'schedule_run',
        tool: 'schedules',
        ok: true,
        payload: { schedule_id: params.id, result },
      });
      return { result: result ?? {}, schedule: normalizeSchedule(target) };
    },
  };

  // -------------------------------------------------------------------------
  // SSE：一次对话
  // -------------------------------------------------------------------------

  async function handleChat({ req, res, params, body }) {
    const r = repo();
    const session = await r.getSession(db, params.id);
    if (!session) throw notFound(`会话 ${params.id} 不存在`);
    const content = V.assertMessageContent(body.content);
    const rt = runtime();
    const startedAt = Date.now();
    const sessionId = params.id;

    const sse = openSse(req, res, { heartbeatMs });
    let aborted = false;
    let sawDone = false;
    /** @type {string[]} */
    const assistantParts = [];

    if (sse.signal) {
      sse.signal.addEventListener('abort', () => {
        aborted = true;
      }, { once: true });
    }

    await audit({
      session_id: sessionId,
      actor: 'agent',
      kind: 'turn_started',
      ok: true,
      payload: { content: redact(content) },
    });

    const emit = (event) => {
      if (sse.stopped) return null;
      const payload = { ...event };
      if (payload.type === 'done') sawDone = true;
      if (payload.type === 'assistant_delta' && typeof payload.text === 'string') {
        assistantParts.push(payload.text);
      }
      if (payload.type === 'session' && !payload.session_id) payload.session_id = sessionId;
      if (payload.type === 'done' && typeof payload.finish_reason !== 'string') {
        payload.finish_reason = aborted ? 'aborted' : 'stop';
      }
      return sse.send(payload) ? payload : null;
    };

    // 会话转录兜底：生产 runtime 自己落库 user+assistant（见 runtime.mjs persistMessage），
    // 这里只在「runtime 没落库」时补写 user 消息（保证会话历史不为空，且不重复）。
    async function ensureTranscript() {
      try {
        if (typeof r.appendMessage !== 'function') return;
        const rows = asList(await r.listMessages(db, sessionId), 'messages');
        if (!rows.some((row) => row?.role === 'user')) {
          await r.appendMessage(db, { session_id: sessionId, role: 'user', content: { text: content } });
        }
      } catch {
        /* 落库失败不阻断流 */
      }
    }

    try {
      const result = await rt.run({
        sessionId,
        userMessage: content,
        onEvent: emit,
        signal: sse.signal,
      });
      const abortedNow = aborted || sse.signal?.aborted === true || sse.stopped;
      const finishReason = abortedNow ? 'aborted' : (result?.finish_reason ?? 'stop');

      await ensureTranscript();
      await audit({
        session_id: sessionId,
        actor: 'agent',
        kind: abortedNow ? 'turn_aborted' : 'turn_finished',
        ok: !abortedNow,
        duration_ms: Date.now() - startedAt,
        payload: abortedNow
          ? { reason: 'client_disconnected', finish_reason: finishReason }
          : { finish_reason: finishReason, usage: result?.usage ?? null },
      });

      if (!sawDone && !sse.stopped) emit({ type: 'done', finish_reason: finishReason });
    } catch (err) {
      const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
      const message = redact(err?.message ?? '对话失败');
      emit({ type: 'error', code, message });
      await audit({
        session_id: sessionId,
        actor: 'agent',
        kind: 'turn_error',
        ok: false,
        duration_ms: Date.now() - startedAt,
        payload: { code, message },
      });
      if (!sawDone) emit({ type: 'done', finish_reason: 'error' });
    } finally {
      if (!sse.stopped) sse.end();
    }
    return { handled: true };
  }

  // -------------------------------------------------------------------------
  // 路由表
  // -------------------------------------------------------------------------

  const routes = [
    { method: 'GET', path: /^\/api\/health$/, handler: handlers.health },
    { method: 'GET', path: /^\/api\/meta$/, handler: handlers.meta },
    { method: 'GET', path: /^\/api\/assumptions$/, handler: handlers.assumptions },

    { method: 'POST', path: /^\/api\/sessions$/, handler: handlers.createSession },
    { method: 'GET', path: /^\/api\/sessions$/, handler: handlers.listSessions },
    { method: 'GET', path: /^\/api\/sessions\/(?<id>[^/]+)$/, handler: handlers.getSession },
    { method: 'DELETE', path: /^\/api\/sessions\/(?<id>[^/]+)$/, handler: handlers.deleteSession },
    { method: 'POST', path: /^\/api\/sessions\/(?<id>[^/]+)\/messages$/, handler: handleChat, sse: true },
    {
      method: 'POST',
      path: /^\/api\/sessions\/(?<id>[^/]+)\/approvals\/(?<approval_id>[^/]+)$/,
      handler: handlers.resolveApproval,
    },
    { method: 'GET', path: /^\/api\/approvals$/, handler: handlers.listApprovals },

    { method: 'GET', path: /^\/api\/plans$/, handler: handlers.listPlans },
    { method: 'POST', path: /^\/api\/plans$/, handler: handlers.createPlan },
    { method: 'GET', path: /^\/api\/plans\/(?<id>[^/]+)$/, handler: handlers.getPlan },
    { method: 'PUT', path: /^\/api\/plans\/(?<id>[^/]+)$/, handler: handlers.updatePlan },
    { method: 'DELETE', path: /^\/api\/plans\/(?<id>[^/]+)$/, handler: handlers.deletePlan },

    { method: 'GET', path: /^\/api\/suggestions$/, handler: handlers.suggestions },
    { method: 'GET', path: /^\/api\/workbench$/, handler: handlers.workbench },
    { method: 'GET', path: /^\/api\/sku\/(?<code>[^/]+)$/, handler: handlers.skuDetail },

    { method: 'GET', path: /^\/api\/inventory$/, handler: handlers.inventory },
    { method: 'GET', path: /^\/api\/safety-stock$/, handler: handlers.getSafetyStock },
    { method: 'PUT', path: /^\/api\/safety-stock$/, handler: handlers.updateSafetyStock },

    { method: 'GET', path: /^\/api\/holidays$/, handler: handlers.listHolidays },
    { method: 'POST', path: /^\/api\/holidays$/, handler: handlers.addHoliday },
    { method: 'DELETE', path: /^\/api\/holidays$/, handler: handlers.removeHoliday },
    { method: 'DELETE', path: /^\/api\/holidays\/(?<date>[^/]+)$/, handler: handlers.removeHoliday },

    { method: 'GET', path: /^\/api\/drafts$/, handler: handlers.listDrafts },
    { method: 'POST', path: /^\/api\/drafts$/, handler: handlers.createDraft },
    { method: 'GET', path: /^\/api\/drafts\/(?<id>[^/]+)$/, handler: handlers.getDraft },
    { method: 'POST', path: /^\/api\/drafts\/(?<id>[^/]+)\/commit$/, handler: handlers.commitDraft },

    { method: 'GET', path: /^\/api\/orders$/, handler: handlers.listOrders },
    { method: 'GET', path: /^\/api\/audit$/, handler: handlers.audit },

    { method: 'GET', path: /^\/api\/schedules$/, handler: handlers.listSchedules },
    { method: 'POST', path: /^\/api\/schedules\/(?<id>[^/]+)\/run$/, handler: handlers.runSchedule },
  ];

  // -------------------------------------------------------------------------
  // 分发
  // -------------------------------------------------------------------------

  /** 处理 `/api/*`。返回 true 表示已处理；false 表示不是 API 请求（交给静态服务）。 */
  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      applyCommonHeaders(res, { api: true });
      sendError(res, internalError('请求 URL 不合法'));
      return true;
    }

    const pathname =
      url.pathname.length > 4 && url.pathname.startsWith('/api')
        ? url.pathname.replace(/\/+$/, '') || '/api'
        : url.pathname;
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return false;

    applyCommonHeaders(res, { api: true });

    const method = String(req.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.setHeader('Allow', 'GET,POST,PUT,DELETE,OPTIONS');
      res.statusCode = 204;
      res.end();
      return true;
    }

    const matches = [];
    for (const route of routes) {
      const m = route.path.exec(pathname);
      if (m) matches.push({ route, m });
    }

    if (matches.length === 0) {
      sendError(res, notFound(`未找到接口：${method} ${pathname}`));
      return true;
    }

    const hit = matches.find((entry) => entry.route.method === method);
    if (!hit) {
      const allowed = [...new Set(matches.map((entry) => entry.route.method))].join(', ');
      sendError(res, notFound(`接口不支持 ${method}（允许：${allowed}）：${pathname}`));
      return true;
    }

    const { route, m } = hit;
    const params = m.groups ?? {};

    try {
      let body = {};
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        body = await readJson(req);
      }
      const result = await route.handler({ req, res, params, query: url.searchParams, body });
      if (result && result.handled) return true;
      if (result && result.__status) {
        const { __status, ...data } = result;
        sendOk(res, data, { status: __status });
        return true;
      }
      sendOk(res, result ?? {});
      return true;
    } catch (err) {
      if (res.headersSent) {
        // SSE 已开流：只能断流，不能改写状态码
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
        return true;
      }
      applyCommonHeaders(res, { api: true });
      sendError(res, err);
      return true;
    }
  }

  return {
    handle,
    routes,
    listRoutes: () => routes.map((route) => ({ method: route.method, pattern: String(route.path) })),
  };
}

export default { createRouter, todayInTimezone, SERVICE_NAME };
