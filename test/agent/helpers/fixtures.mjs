/**
 * fixtures.mjs — test/agent 的离线夹具
 * ---------------------------------------------------------------------------
 * 用**真实领域内核**（server/domain） + **内存假数据层**，因此单测既能验证工具/运行时的
 * 协议与护栏，又能真实跑通领域计算，不依赖 SQLite seed、不联网。
 *
 * 自测：node --test test/agent
 */
import * as domain from '../../../server/domain/index.mjs';
import { createToolRegistry } from '../../../server/agent/tools/index.mjs';
import { createRuntime } from '../../../server/agent/runtime.mjs';
import { createMockProvider } from '../../../server/providers/mock.mjs';
import { createDeps } from '../../../server/agent/tools/deps.mjs';

export { domain };
export const AS_OF = '2026-10-29';
export const CLOCK_MS = Date.parse('2026-10-29T02:00:00.000Z'); // = 10:00 UTC+8

const round2 = (n) => domain.roundTo(n, 2);

/** 最近 n 个自然日（升序，含 asOf） */
export function dates(n, end = AS_OF) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(domain.addDays(end, -i));
  return out;
}

/** 15 天总量 total 的销量序列（全部落在最后一天，避免星期因子干扰） */
export function salesOfTotal(total, end = AS_OF) {
  const list = dates(15, end);
  return list.map((date, i) => ({ date, qty: i === 14 ? total : 0, outbound_type: 'sale' }));
}

/** 领域层 shape 的 SKU（同时带 sku_code/code、product_name/name，验证工具归一化） */
export const DEFAULT_SKUS = [
  {
    id: 1,
    sku_id: 1,
    code: 'SP001',
    sku_code: 'SP001',
    sku_no: 'SH001-00001',
    name: '农夫山泉饮用水',
    product_name: '农夫山泉饮用水',
    spec: '550ml*24瓶/箱',
    unit: '箱',
    category: '饮料',
    cost_price: 22,
    tax_rate: 0.13,
    store_id: 'ST01',
    store_name: '上海静安嘉里中心店',
    supplier_code: 'GYS003',
    supplier_name: '农夫山泉上海仓',
  },
  {
    id: 2,
    sku_id: 2,
    code: 'SP002',
    sku_code: 'SP002',
    sku_no: 'SH001-00002',
    name: '可口可乐',
    product_name: '可口可乐',
    spec: '330ml*24罐/箱',
    unit: '箱',
    category: '饮料',
    cost_price: 30,
    tax_rate: 0.13,
    store_id: 'ST01',
    store_name: '上海静安嘉里中心店',
    supplier_code: 'GYS004',
    supplier_name: '可口可乐上海仓',
  },
  {
    id: 3,
    sku_id: 3,
    code: 'SP003',
    sku_code: 'SP003',
    sku_no: 'SH001-00003',
    name: '无库存快照商品',
    product_name: '无库存快照商品',
    spec: '1件',
    unit: '件',
    category: '百货',
    cost_price: 10,
    tax_rate: 0.13,
    store_id: 'ST01',
    store_name: '上海静安嘉里中心店',
  },
];

export const DEFAULT_PLAN = {
  plan_id: 'plan_default',
  plan_name: '标准补货方案',
  is_default: true,
  provenance: 'documented',
  config: {
    plan_type: 'avg_daily',
    purchase_cycle_days: 7,
    coverage_days: 15,
    coefficient_enabled: 0,
    weekend_coefficient_enabled: 0,
    holiday_coefficient_enabled: 0,
  },
};

/**
 * 内存假数据层（实现 contracts §3 中被 Agent 用到的子集）
 * @param {{today?: string, skus?: Array<object>, inventory?: Record<string, object>,
 *          sales?: Record<string, Array<object>>, plans?: Array<object>,
 *          schedules?: Array<object>, safety?: object}} [seed]
 */
export function createFakeRepository(seed = {}) {
  const today = seed.today ?? AS_OF;
  const skus = seed.skus ?? DEFAULT_SKUS;
  const inventory = seed.inventory ?? {
    1: { on_hand: 0, locked: 0, in_transit: 0, plan_stock: 0, snapshot_date: today },
    // SP002 库存快照过期（8 天前）→ flags 应含 stale_data，调度器必须过滤掉
    2: { on_hand: 0, locked: 0, in_transit: 0, plan_stock: 0, snapshot_date: domain.addDays(today, -8) },
    // SP003 故意没有库存快照 → 域层 DATA_MISSING
  };
  const sales = seed.sales ?? {
    1: salesOfTotal(10),
    2: salesOfTotal(20),
    3: salesOfTotal(0),
  };
  const plans = seed.plans ?? [DEFAULT_PLAN];
  const schedules = seed.schedules ?? [
    {
      id: 'sch_1',
      name: '每日巡店补货',
      cadence: 'daily@09:00',
      plan_id: 'plan_default',
      store_id: 'ST01',
      enabled: true,
      last_run_at: null,
      next_run_at: '2026-10-29T00:00:00.000Z', // 已到期（now=02:00Z）
    },
  ];

  let draftSeq = 0;
  let orderSeq = 0;
  let approvalSeq = 0;
  let auditSeq = 0;
  let artifactSeq = 0;
  let messageSeq = 0;
  const state = {
    drafts: [],
    orders: [],
    approvals: [],
    audits: [],
    artifacts: [],
    messages: [],
    sessions: [],
    scheduleRuns: [],
    schedules: schedules.map((s) => ({ ...s })),
  };

  const repo = {
    state,
    getMeta: async () => ({
      today,
      stores: [{ store_id: 'ST01', store_name: '上海静安嘉里中心店' }],
      suppliers: [],
      categories: ['饮料', '百货'],
      plans,
      counts: { sku: skus.length, store: 1, sales_days: 15 },
    }),
    listSkus: async (_db, q = {}) => {
      let rows = [...skus];
      if (q.store_id) rows = rows.filter((s) => s.store_id === q.store_id);
      if (q.category) rows = rows.filter((s) => s.category === q.category);
      if (q.keyword) {
        const kw = String(q.keyword);
        rows = rows.filter(
          (s) =>
            s.sku_code.includes(kw) ||
            (s.product_name ?? '').includes(kw) ||
            (s.name ?? '').includes(kw) ||
            String(s.sku_no ?? '').includes(kw),
        );
      }
      return rows.slice(0, q.limit ?? 50);
    },
    getSkuByCode: async (_db, code) => skus.find((s) => (s.sku_code ?? s.code) === code) ?? null,
    getInventory: async (_db, skuId) => inventory[skuId] ?? null,
    getSales: async (_db, skuId) => sales[skuId] ?? [],
    getSafetyConfig: async () => seed.safety ?? { mode: 'fixed', lower_fixed: 10, upper_fixed: 100 },
    listHolidays: async () => [],
    listPlans: async () => plans.map((p) => ({ ...p })),
    getPlan: async (_db, planId) => plans.find((p) => p.plan_id === planId) ?? null,

    createOrderDraft: async (_db, input) => {
      draftSeq += 1;
      const items = (input.items ?? []).map((item) => {
        const sku = skus.find((s) => (s.sku_code ?? s.code) === item.sku_code);
        const unitCost = Number(sku?.cost_price ?? 0);
        return {
          sku_code: item.sku_code,
          product_name: sku?.product_name ?? sku?.name ?? '',
          unit: sku?.unit ?? '',
          apply_num: item.apply_num,
          unit_cost: unitCost,
          amount: round2(item.apply_num * unitCost),
        };
      });
      const totalQty = items.reduce((a, i) => a + i.apply_num, 0);
      const totalAmount = round2(items.reduce((a, i) => a + i.amount, 0));
      const draft = {
        draft_id: `draft_${draftSeq}`,
        kind: input.kind,
        items,
        total_qty: totalQty,
        total_amount: totalAmount,
        expected_arrival: input.expected_arrival ?? null,
        remark: input.remark ?? '',
        session_id: input.session_id ?? null,
        created_by: input.created_by ?? 'agent',
        status: 'draft',
        created_at: `${today}T00:00:0${draftSeq}.000Z`,
      };
      state.drafts.push(draft);
      return { ...draft };
    },
    getDraft: async (_db, id) => state.drafts.find((d) => d.draft_id === id) ?? null,
    listDrafts: async (_db, q = {}) =>
      state.drafts.filter((d) => !q.status || d.status === q.status).map((d) => ({ ...d })),
    commitDraft: async (_db, id, { approval_id, operator } = {}) => {
      const draft = state.drafts.find((d) => d.draft_id === id);
      if (!draft) throw Object.assign(new Error(`草稿不存在：${id}`), { code: 'NOT_FOUND' });
      if (draft.status !== 'draft') throw Object.assign(new Error(`草稿状态不是 draft：${draft.status}`), { code: 'CONFLICT' });
      orderSeq += 1;
      const order = {
        order_id: `ord_${orderSeq}`,
        biz_no: `PO${today.replace(/-/g, '')}${String(orderSeq).padStart(4, '0')}`,
        kind: draft.kind,
        draft_id: draft.draft_id,
        items: draft.items,
        total_qty: draft.total_qty,
        total_amount: draft.total_amount,
        status: 'committed',
        approval_id,
        operator,
        created_at: `${today}T00:01:00.000Z`,
      };
      draft.status = 'committed';
      state.orders.push(order);
      return { ...order };
    },

    appendAudit: async (_db, event) => {
      auditSeq += 1;
      const record = {
        id: `aud_${auditSeq}`,
        ts: `${today}T00:00:${String(auditSeq % 60).padStart(2, '0')}.000Z`,
        actor: 'agent',
        ok: true,
        duration_ms: 0,
        ...event,
      };
      state.audits.push(record);
      return record;
    },
    searchAudit: async (_db, q = {}) =>
      state.audits
        .filter((a) => (!q.session_id || a.session_id === q.session_id) && (!q.kind || a.kind === q.kind))
        .slice(-(q.limit ?? 50))
        .map((a) => ({ ...a })),

    createApproval: async (_db, input) => {
      approvalSeq += 1;
      const approval = {
        id: `apr_${approvalSeq}`,
        session_id: input.session_id ?? null,
        draft_id: input.draft_id,
        kind: input.kind ?? 'order_commit',
        summary: input.summary ?? '',
        risk: input.risk ?? 'medium',
        requested_by: input.requested_by ?? 'agent',
        status: 'pending',
        created_at: `${today}T00:02:0${approvalSeq % 10}.000Z`,
      };
      state.approvals.push(approval);
      return { ...approval };
    },
    getApproval: async (_db, id) => state.approvals.find((a) => a.id === id) ?? null,
    listApprovals: async (_db, q = {}) =>
      state.approvals
        .filter((a) => (!q.session_id || a.session_id === q.session_id) && (!q.status || a.status === q.status))
        .map((a) => ({ ...a })),
    resolveApproval: async (_db, id, { decision, note = '', operator = 'human' } = {}) => {
      const approval = state.approvals.find((a) => a.id === id);
      if (!approval) throw Object.assign(new Error(`审批不存在：${id}`), { code: 'NOT_FOUND' });
      approval.status = decision === 'approve' ? 'approved' : 'rejected';
      approval.note = note;
      approval.operator = operator;
      approval.resolved_at = `${today}T00:03:00.000Z`;
      return { ...approval };
    },

    listSchedules: async () => state.schedules.map((s) => ({ ...s })),
    saveSchedule: async (_db, schedule) => {
      const index = state.schedules.findIndex((s) => s.id === (schedule.id ?? schedule.schedule_id));
      if (index >= 0) state.schedules[index] = { ...state.schedules[index], ...schedule };
      else state.schedules.push({ ...schedule, id: schedule.id ?? `sch_${state.schedules.length + 1}` });
      return { ...state.schedules.at(-1) };
    },
    markScheduleRun: async (_db, id, result) => {
      state.scheduleRuns.push({ schedule_id: id, result: { ...result } });
      const schedule = state.schedules.find((s) => s.id === id);
      if (schedule) {
        schedule.last_run_at = result.last_run_at ?? null;
        if (result.next_run_at) schedule.next_run_at = result.next_run_at;
      }
      return { ...result };
    },

    createSession: async (_db, { title = '' } = {}) => {
      const session = { session_id: `sess_${state.sessions.length + 1}`, title, created_at: `${today}T00:00:00.000Z` };
      state.sessions.push(session);
      return session;
    },
    getSession: async (_db, id) => state.sessions.find((s) => s.session_id === id) ?? null,
    listSessions: async () => state.sessions.map((s) => ({ ...s })),
    appendMessage: async (_db, message) => {
      messageSeq += 1;
      const record = { id: `msg_${messageSeq}`, ts: `${today}T00:00:${String(messageSeq % 60).padStart(2, '0')}.000Z`, ...message };
      state.messages.push(record);
      return record;
    },
    listMessages: async (_db, sessionId) =>
      state.messages.filter((m) => m.session_id === sessionId).map((m) => ({ ...m })),
    saveArtifact: async (_db, artifact) => {
      artifactSeq += 1;
      const record = { artifact_id: `art_${artifactSeq}`, ...artifact };
      state.artifacts.push(record);
      return record;
    },
    listArtifacts: async (_db, sessionId) =>
      state.artifacts.filter((a) => !sessionId || a.session_id === sessionId).map((a) => ({ ...a })),
  };
  return repo;
}

/**
 * 组装一次性测试环境：真实 domain + 假 repository + 工具注册表 + mock provider + runtime。
 * @param {{script?: any, limits?: object, extraTools?: Array<object>, seed?: object,
 *          provider?: object, repository?: object, queries?: object}} [opts]
 */
export function createHarness(opts = {}) {
  const db = { name: 'fake-db' };
  const repository = opts.repository ?? createFakeRepository(opts.seed);
  const clock = opts.clock ?? (() => CLOCK_MS);
  const deps = createDeps({ domain, repository, queries: opts.queries ?? null });
  const limits = opts.limits ?? {};
  const tools = createToolRegistry({ db, deps, clock, limits, extraTools: opts.extraTools ?? [] });
  const provider = opts.provider ?? createMockProvider({ script: opts.script });
  const runtime = createRuntime({ db, provider, tools, clock, limits, repository, domain });
  return { db, repository, domain, deps, tools, provider, runtime, clock, limits };
}

/** 跑一轮并收集事件 */
export async function runTurn(runtime, { sessionId = 'sess_1', message, signal } = {}) {
  const events = [];
  const result = await runtime.run({
    sessionId,
    userMessage: message,
    onEvent: (event) => events.push(event),
    signal,
  });
  return { events, result };
}

/** 事件类型序列（过滤掉高频 delta，便于断言主线） */
export function mainTypes(events) {
  return events.filter((e) => e.type !== 'reasoning_delta' && e.type !== 'assistant_delta').map((e) => e.type);
}

export function eventsOfType(events, type) {
  return events.filter((e) => e.type === type);
}

export function toolCallNames(events) {
  return eventsOfType(events, 'tool_call').map((e) => e.name);
}

/** 简单休眠（模拟慢工具） */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
