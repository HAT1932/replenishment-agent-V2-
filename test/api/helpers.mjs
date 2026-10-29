/**
 * test/api/helpers.mjs — API 测试用的进程内服务与内存 stub
 * ---------------------------------------------------------------------------
 * 目的：HTTP/SSE 层的冒烟测试必须**确定性**且不依赖真实 SQLite / 真实 LLM。
 * 这里给出契约（docs/contracts.md §3/§5/§6）对应形状的 stub：
 *   - `createStubRepo()`   内存版 repository（函数名与 Lead 确认的一致）
 *   - `createStubQueries()` 读模型 stub（buildSuggestions / getSkuDetail）
 *   - `createStubDomain()`  只提供路由真正用到的常量
 *   - `createStubRuntime()` 按脚本回放 SSE 事件
 * 真实集成由 scripts/verify.mjs 覆盖。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../server/index.mjs';

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const FIXED_TODAY = '2026-01-15';

// ---------------------------------------------------------------------------
// 内存仓储
// ---------------------------------------------------------------------------

const SYSTEM_PLANS = [
  {
    plan_id: 'plan_avg',
    plan_name: '方案1·日均销量',
    plan_type: 'avg_daily',
    formula_text: '建议数量 = 日均销量 × (采购周期 + 覆盖天数) − 可售库存',
    is_system: true,
    config: { purchase_cycle_days: 7, coverage_days: 3, coefficient_enabled: false },
  },
  {
    plan_id: 'plan_upper',
    plan_name: '方案2·库存上限',
    plan_type: 'stock_upper',
    formula_text: '建议数量 = 库存上限 − 可售库存',
    is_system: true,
    config: { coefficient_enabled: false },
  },
];

const STORE = { store_id: 'store_001', store_name: '演示门店' };

const SKUS = [
  {
    sku_id: 'sku_001',
    sku_code: 'SKU-001',
    sku_no: 'P0001',
    product_name: '蒙牛纯牛奶 250ml',
    spec: '250ml*24',
    unit: '箱',
    category: '乳制品',
    store_id: STORE.store_id,
    store_name: STORE.store_name,
    supplier_code: 'SUP-01',
    supplier_name: '蒙牛供应链',
    warehouse_code: 'WH-01',
  },
  {
    sku_id: 'sku_002',
    sku_code: 'SKU-002',
    sku_no: 'P0002',
    product_name: '农夫山泉 550ml',
    spec: '550ml*12',
    unit: '箱',
    category: '饮料',
    store_id: STORE.store_id,
    store_name: STORE.store_name,
    supplier_code: 'SUP-02',
    supplier_name: '农夫山泉供应链',
    warehouse_code: 'WH-01',
  },
];

const INVENTORY = {
  sku_001: { on_hand: 12, locked: 2, sellable: 10, in_transit: 0, plan_stock: 20, snapshot_date: '2026-01-14', staleness_days: 1 },
  sku_002: { on_hand: 60, locked: 0, sellable: 60, in_transit: 24, plan_stock: 80, snapshot_date: '2026-01-14', staleness_days: 1 },
};

let counter = 0;
const nextId = (prefix) => `${prefix}_${String(++counter).padStart(6, '0')}`;

export function createStubRepo() {
  const sessions = new Map();
  const messages = new Map();
  const artifacts = new Map();
  const plans = new Map(SYSTEM_PLANS.map((plan) => [plan.plan_id, structuredClone(plan)]));
  const approvals = new Map();
  const drafts = new Map();
  const orders = [];
  const audit = [];
  const schedules = [
    {
      id: 'sch_001',
      name: '每日补货草稿',
      cadence: '0 8 * * *',
      plan_id: 'plan_avg',
      enabled: true,
      last_run_at: null,
      next_run_at: '2026-01-16T00:00:00.000Z',
    },
  ];
  const holidays = new Set(['2026-01-01']);
  let safety = {
    mode: 'fixed',
    lower_fixed: 5,
    upper_fixed: 30,
    min_sellable_days: 3,
    max_sellable_days: 15,
    store_id: STORE.store_id,
  };

  return {
    calls: [],
    _sessions: sessions,
    _messages: messages,
    _approvals: approvals,
    _drafts: drafts,
    _orders: orders,
    _audit: audit,
    _plans: plans,
    _schedules: schedules,

    getMeta() {
      return {
        today: FIXED_TODAY,
        stores: [STORE],
        suppliers: [{ supplier_code: 'SUP-01', supplier_name: '蒙牛供应链' }],
        categories: ['乳制品', '饮料'],
        plans: [...plans.values()],
        counts: { sku: SKUS.length, store: 1, sales_days: 180 },
      };
    },
    getSkuCounts() {
      return { sku: SKUS.length, store: 1, sales_days: 180 };
    },
    listSkus(_db, { store_id, category, keyword, limit } = {}) {
      let rows = SKUS.slice();
      if (store_id) rows = rows.filter((sku) => sku.store_id === store_id);
      if (category) rows = rows.filter((sku) => sku.category === category);
      if (keyword) rows = rows.filter((sku) => sku.product_name.includes(keyword));
      if (Number.isInteger(limit) && limit > 0) rows = rows.slice(0, limit);
      return rows;
    },
    getSkuByCode(_db, code) {
      return SKUS.find((sku) => sku.sku_code === code) ?? null;
    },
    getInventory(_db, skuId) {
      return INVENTORY[skuId] ? { ...INVENTORY[skuId] } : null;
    },
    getSales() {
      return [{ date: '2026-01-14', qty: 3, outbound_type: 'sale' }];
    },
    getSafetyConfig() {
      return { ...safety };
    },
    saveSafetyConfig(_db, patch) {
      safety = { ...safety, ...patch };
      return { ...safety };
    },
    listHolidays() {
      return [...holidays];
    },
    addHoliday(_db, { date, name }) {
      holidays.add(date);
      return { date, name: name ?? '' };
    },
    removeHoliday(_db, date) {
      holidays.delete(date);
      return true;
    },

    listPlans() {
      return [...plans.values()];
    },
    getPlan(_db, id) {
      return plans.get(id) ?? null;
    },
    createPlan(_db, payload) {
      const plan = { plan_id: nextId('plan'), is_system: false, ...payload };
      plans.set(plan.plan_id, plan);
      return plan;
    },
    updatePlan(_db, id, patch) {
      const current = plans.get(id);
      if (!current) throw Object.assign(new Error('Plan not found'), { code: 'NOT_FOUND' });
      const updated = { ...current, ...patch, config: { ...(current.config ?? {}), ...(patch.config ?? {}) } };
      plans.set(id, updated);
      return updated;
    },
    deletePlan(_db, id) {
      const plan = plans.get(id);
      if (!plan) throw Object.assign(new Error('Plan not found'), { code: 'NOT_FOUND' });
      if (plan.is_system) {
        throw Object.assign(new Error('系统默认方案不允许删除'), { code: 'CONFLICT' });
      }
      plans.delete(id);
      return true;
    },

    createSession(_db, { title }) {
      const session = {
        session_id: nextId('sess'),
        title: title ?? '新会话',
        created_at: '2026-01-15T00:00:00.000Z',
        last_message_at: null,
      };
      sessions.set(session.session_id, session);
      messages.set(session.session_id, []);
      artifacts.set(session.session_id, []);
      return session;
    },
    getSession(_db, id) {
      return sessions.get(id) ?? null;
    },
    listSessions() {
      return [...sessions.values()];
    },
    deleteSession(_db, id) {
      sessions.delete(id);
      messages.delete(id);
      artifacts.delete(id);
      return true;
    },
    appendMessage(_db, payload) {
      const list = messages.get(payload.session_id) ?? [];
      const message = { message_id: nextId('msg'), role: payload.role, content: payload.content, created_at: new Date(0).toISOString() };
      list.push(message);
      messages.set(payload.session_id, list);
      return message;
    },
    listMessages(_db, id) {
      return messages.get(id) ?? [];
    },
    saveArtifact(_db, payload) {
      const list = artifacts.get(payload.session_id) ?? [];
      const artifact = { artifact_id: nextId('art'), ...payload };
      list.push(artifact);
      artifacts.set(payload.session_id, list);
      return artifact;
    },
    getArtifact(_db, id) {
      for (const list of artifacts.values()) {
        const found = list.find((item) => item.artifact_id === id);
        if (found) return found;
      }
      return null;
    },
    listArtifacts(_db, id) {
      return artifacts.get(id) ?? [];
    },

    createApproval(_db, payload) {
      const approval = {
        id: nextId('appr'),
        status: 'pending',
        kind: payload.kind ?? 'order_commit',
        summary: payload.summary ?? '',
        risk: payload.risk ?? 'medium',
        session_id: payload.session_id ?? null,
        draft_id: payload.draft_id ?? null,
        created_at: '2026-01-15T00:00:00.000Z',
      };
      approvals.set(approval.id, approval);
      return approval;
    },
    getApproval(_db, id) {
      return approvals.get(id) ?? null;
    },
    listApprovals(_db, { session_id, status } = {}) {
      let rows = [...approvals.values()];
      if (session_id) rows = rows.filter((item) => item.session_id === session_id);
      if (status) rows = rows.filter((item) => item.status === status);
      return rows;
    },
    resolveApproval(_db, id, { decision, note, operator }) {
      const current = approvals.get(id);
      if (!current) throw Object.assign(new Error('审批不存在'), { code: 'NOT_FOUND' });
      if (current.status !== 'pending') throw Object.assign(new Error('审批已处理'), { code: 'CONFLICT' });
      current.status = decision === 'approve' ? 'approved' : 'rejected';
      current.note = note ?? '';
      current.operator = operator ?? 'human';
      approvals.set(id, current);
      return current;
    },

    createOrderDraft(_db, payload) {
      const draft = {
        draft_id: nextId('draft'),
        status: 'draft',
        kind: payload.kind ?? 'purchase',
        items: payload.items ?? [],
        expected_arrival: payload.expected_arrival ?? null,
        remark: payload.remark ?? '',
        session_id: payload.session_id ?? null,
        created_at: '2026-01-15T00:00:00.000Z',
      };
      drafts.set(draft.draft_id, draft);
      return draft;
    },
    getDraft(_db, id) {
      return drafts.get(id) ?? null;
    },
    listDrafts(_db, query = {}) {
      let rows = [...drafts.values()];
      if (query?.status) rows = rows.filter((item) => item.status === query.status);
      return rows;
    },
    commitDraft(_db, id, { approval_id, operator }) {
      const draft = drafts.get(id);
      if (!draft) throw Object.assign(new Error('草稿不存在'), { code: 'NOT_FOUND' });
      // 幂等：draft_id 唯一
      const existing = orders.find((order) => order.draft_id === id);
      if (existing) return existing;
      const order = {
        order_id: nextId('order'),
        draft_id: id,
        kind: draft.kind,
        biz_no: `PO2026011500${orders.length + 1}`,
        status: 'committed',
        approval_id,
        operator: operator ?? 'human',
        items: draft.items,
      };
      orders.push(order);
      draft.status = 'committed';
      draft.order = order;
      return order;
    },
    listOrders(_db, { kind, limit } = {}) {
      let rows = orders.slice();
      if (kind) rows = rows.filter((item) => item.kind === kind);
      return Number.isInteger(limit) ? rows.slice(0, limit) : rows;
    },

    appendAudit(_db, event) {
      const record = {
        id: nextId('audit'),
        ts: '2026-01-15T00:00:00.000Z',
        ok: true,
        session_id: null,
        kind: 'unknown',
        ...event,
      };
      audit.push(record);
      return record;
    },
    searchAudit(_db, { session_id, kind, limit } = {}) {
      let rows = audit.slice().reverse();
      if (session_id) rows = rows.filter((item) => item.session_id === session_id);
      if (kind) rows = rows.filter((item) => item.kind === kind);
      return Number.isInteger(limit) ? rows.slice(0, limit) : rows;
    },

    listSchedules() {
      return schedules.map((item) => ({ ...item }));
    },
    markScheduleRun(_db, id, result) {
      const target = schedules.find((item) => item.id === id);
      if (target) target.last_run_at = '2026-01-15T01:00:00.000Z';
      return { id, result };
    },
  };
}

// ---------------------------------------------------------------------------
// 读模型 / 域 / runtime stub
// ---------------------------------------------------------------------------

export function createStubQueries() {
  const seen = [];
  return {
    seen,
    buildSuggestions(_db, options) {
      seen.push(options);
      const rows = [
        {
          sku_id: 'sku_001',
          sku_code: 'SKU-001',
          product_name: '蒙牛纯牛奶 250ml',
          stock_upper: 30,
          stock_lower: 8,
          avg_daily_sales: 1.5,
          sellable_stock: 10,
          in_transit_stock: 0,
          suggest_num: 12,
          apply_num: 12,
          guard: { passed: true, policy: 'physical_plus_transit', text: '可售+在途 < 下限' },
          flags: ['stale_data'],
          provenance: 'documented',
          plan_id: options.plan_id ?? 'plan_avg',
          plan_name: '方案1·日均销量',
          plan_type: 'avg_daily',
          amount: 120.5,
          terms: {},
          coefficient_detail: [],
        },
        {
          sku_id: 'sku_002',
          sku_code: 'SKU-002',
          product_name: '农夫山泉 550ml',
          stock_upper: 80,
          stock_lower: 20,
          avg_daily_sales: 6,
          sellable_stock: 60,
          in_transit_stock: 24,
          suggest_num: 0,
          apply_num: 0,
          guard: { passed: false, policy: 'physical_plus_transit', text: '库存充足' },
          flags: [],
          provenance: 'documented',
          plan_id: options.plan_id ?? 'plan_avg',
          plan_name: '方案1·日均销量',
          plan_type: 'avg_daily',
          amount: 0,
          terms: {},
          coefficient_detail: [],
        },
      ];
      let filtered = rows;
      if (options.only_low) filtered = filtered.filter((row) => row.guard.passed);
      const page = options.page ?? 1;
      const pageSize = options.page_size ?? 50;
      const offset = (page - 1) * pageSize;
      return {
        as_of: options.as_of ?? FIXED_TODAY,
        expected_arrival: options.expected_arrival ?? null,
        plan: { plan_id: options.plan_id ?? 'plan_avg', plan_name: '方案1·日均销量', plan_type: 'avg_daily' },
        formula_text: '建议数量 = 日均销量 × (采购周期 + 覆盖天数) − 可售库存',
        rows: filtered.slice(offset, offset + pageSize),
        kpi: { sku_count: filtered.length, suggest_total_qty: 12, amount_total: 120.5, low_count: 1 },
        total: filtered.length,
        page,
        page_size: pageSize,
        total_pages: Math.max(1, Math.ceil(filtered.length / pageSize)),
        guard_note: '低预警口径：实物+在途 < 下限',
      };
    },
    getSkuDetail(_db, skuCode, { as_of } = {}) {
      const sku = SKUS.find((item) => item.sku_code === skuCode);
      if (!sku) return null;
      return {
        sku,
        inventory: { ...(INVENTORY[sku.sku_id] ?? {}) },
        sales: [{ date: as_of ?? FIXED_TODAY, qty: 3 }],
        suggestions: [],
        explain: { terms: {}, why: [{ step: '日均销量', expr: 'window(15)', value: 1.5, note: '' }] },
      };
    },
  };
}

export function createStubDomain() {
  return {
    PLAN_TYPES: ['avg_daily', 'stock_upper', 'custom'],
    ASSUMPTIONS: [
      { id: 'H1', statement: '建议数量 = ceil(公式)', confidence: 'medium', evidence: '', risk: '', probe: '' },
    ],
    isValidDate: () => true,
    addDays: () => FIXED_TODAY,
    computeDocumentedSuggestion: () => ({}),
  };
}

/**
 * 按脚本回放的 runtime（契约 §5 事件协议）。
 * @param {{ events?: object[], delayMs?: number, hangs?: boolean }} [options]
 */
export function createStubRuntime(options = {}) {
  const { events, delayMs = 0, hangs = false } = options;
  const calls = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      if (hangs) {
        return new Promise((resolve) => {
          const finish = () => resolve({ finish_reason: args.signal?.aborted ? 'aborted' : 'timeout' });
          if (args.signal?.aborted) return finish();
          args.signal?.addEventListener('abort', finish, { once: true });
          // 保底：避免测试挂死
          setTimeout(finish, 5000).unref?.();
        });
      }
      const script =
        events ??
        [
          { type: 'session', session_id: args.sessionId },
          { type: 'step', step: 1, max_steps: 8 },
          { type: 'reasoning_delta', text: '先看库存…' },
          { type: 'tool_call', call_id: 'call_1', name: 'inventory.get', args: { sku_code: 'SKU-001' }, step: 1 },
          {
            type: 'tool_result',
            call_id: 'call_1',
            name: 'inventory.get',
            ok: true,
            duration_ms: 3,
            summary: '可售 10',
            data: { sellable: 10 },
          },
          { type: 'artifact', artifact: { id: 'art_1', kind: 'suggestions', title: '建议表', ref: 'plan_avg' } },
          { type: 'approval_required', approval: { id: 'appr_1', kind: 'order_commit', summary: '提交采购单', risk: 'medium', ref: 'draft_1' } },
          { type: 'usage', prompt_tokens: 100, completion_tokens: 20, reasoning_tokens: 5 },
          { type: 'assistant_delta', text: '已生成建议。' },
          { type: 'done', finish_reason: 'stop' },
        ];
      for (const event of script) {
        if (args.signal?.aborted) return { finish_reason: 'aborted' };
        args.onEvent({ ...event });
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return { finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 20 } };
    },
  };
}

export function createStubScheduler() {
  const runs = [];
  return {
    runs,
    async triggerSchedule({ scheduleId }) {
      runs.push(scheduleId);
      return { run_id: 'run_001', draft_ids: ['draft_x'], summary: '生成 1 张草稿' };
    },
    async runDueSchedules({ only }) {
      runs.push(only?.[0] ?? 'due');
      return { runs: [{ run_id: 'run_001' }] };
    },
  };
}

export function createStubProvider() {
  return { name: 'mock', model: 'mock-1', supportsStreaming: true, chat: async () => ({ message: {}, usage: {} }) };
}

// ---------------------------------------------------------------------------
// 起服务
// ---------------------------------------------------------------------------

/** 建一个临时 dist（含 index.html 与 assets/app-abc123.js） */
export async function makeTempDist() {
  const dir = await mkdtemp(path.join(tmpdir(), 'repl-api-dist-'));
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(
    path.join(dir, 'index.html'),
    '<!doctype html><html><head><title>演示</title></head><body><div id="root"></div><script type="module" src="/assets/app-abc123.js"></script></body></html>',
    'utf8',
  );
  await writeFile(path.join(dir, 'assets', 'app-abc123.js'), 'export const ok = true;\n', 'utf8');
  return dir;
}

export function makeConfig(overrides = {}) {
  return {
    rootDir: PROJECT_ROOT,
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(tmpdir(), 'repl-api-unused.db'),
    tzOffset: '+08:00',
    llm: { provider: 'mock', model: 'mock-1', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-should-never-leak', timeoutMs: 1000, maxOutputTokens: 256, effort: '' },
    runtime: { maxSteps: 8, maxToolCallsPerTurn: 12, turnBudgetMs: 5000, toolTimeoutMs: 1000 },
    ...overrides,
  };
}

/**
 * 起一个进程内的测试服务（随机端口）。
 * @param {import('node:test').TestContext} t
 * @param {{ repo?: object, queries?: object, domain?: object, runtime?: object,
 *           scheduler?: object, config?: object, heartbeatMs?: number, distDir?: string }} [options]
 */
export async function startTestServer(t, options = {}) {
  const repo = options.repo ?? createStubRepo();
  const queries = options.queries ?? createStubQueries();
  const domain = options.domain ?? createStubDomain();
  const runtime = options.runtime ?? createStubRuntime();
  const scheduler = options.scheduler ?? createStubScheduler();
  const distDir = options.distDir ?? (await makeTempDist());
  const ownDist = !options.distDir;

  const app = await createServer({
    config: options.config ?? makeConfig(),
    db: {},
    provider: createStubProvider(),
    deps: { repo, queries, domain, agent: { runtime, scheduler } },
    staticDir: distDir,
    heartbeatMs: options.heartbeatMs,
  });
  await app.listen(0, '127.0.0.1');

  t.after(async () => {
    await app.close();
    if (ownDist) await rm(distDir, { recursive: true, force: true });
  });

  // 注意：全部用闭包而不是 this，方便测试里解构后直接调用
  const api = {
    app,
    repo,
    queries,
    domain,
    runtime,
    scheduler,
    base: app.url,
    distDir,
  };
  api.fetch = (pathname, init) => fetch(new URL(pathname, app.url), init);
  api.json = async (pathname, init) => {
    const res = await api.fetch(pathname, init);
    const body = await res.json().catch(() => null);
    return { res, body, status: res.status };
  };
  api.postJson = (pathname, payload, init = {}) =>
    api.json(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      ...init,
    });
  return api;
}

/** 把 SSE 响应体解析成事件数组（严格按 `data: ` + 空行切分，与前端一致） */
export async function collectSse(response, { maxEvents = 200 } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const comments = [];
  while (events.length < maxEvents) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (frame.startsWith('data: ')) {
        events.push(JSON.parse(frame.slice('data: '.length)));
      } else if (frame.startsWith(':')) {
        comments.push(frame);
      }
      index = buffer.indexOf('\n\n');
    }
  }
  return { events, comments, remainder: buffer };
}
