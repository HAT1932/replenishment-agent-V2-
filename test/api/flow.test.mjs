/**
 * test/api/flow.test.mjs — 业务链路冒烟（会话 / 方案 / 建议 / 基础数据 / 草稿→审批→提交 / 审计 / 定时）
 * 只验证「路由 + 校验 + 信封 + 转发参数」，业务正确性由 test/domain 与 scripts/verify.mjs 覆盖。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStubRepo, startTestServer } from './helpers.mjs';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function assertErrorEnvelope(body, expectedCode) {
  assert.equal(body.ok, false);
  assert.equal(body.error.code, expectedCode);
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);
}

test('会话：创建 / 列表 / 详情 / 删除', async (t) => {
  const { json, postJson } = await startTestServer(t);

  const created = await postJson('/api/sessions', { title: '补货会话' });
  assert.equal(created.status, 201);
  assert.equal(created.body.ok, true);
  const sessionId = created.body.data.session_id;
  assert.ok(sessionId);

  const list = await json('/api/sessions');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.sessions.some((item) => item.session_id === sessionId));

  const detail = await json(`/api/sessions/${sessionId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.session.session_id, sessionId);
  assert.deepEqual(detail.body.data.messages, []);
  assert.ok(Array.isArray(detail.body.data.artifacts));

  const missing = await json('/api/sessions/sess_unknown');
  assert.equal(missing.status, 404);
  assertErrorEnvelope(missing.body, 'NOT_FOUND');

  const removed = await json(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.deleted, true);

  const afterDelete = await json(`/api/sessions/${sessionId}`);
  assert.equal(afterDelete.status, 404);
});

test('方案：列表 / 详情 / 新增 / 修改 / 删除 / 系统方案禁删', async (t) => {
  const { json, postJson } = await startTestServer(t);

  const list = await json('/api/plans');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.plans.length, 2);

  const one = await json('/api/plans/plan_avg');
  assert.equal(one.status, 200);
  assert.equal(one.body.data.plan_type, 'avg_daily');

  const created = await postJson('/api/plans', {
    plan_name: '方案4·自定义',
    plan_type: 'custom',
    config: { purchase_cycle_days: 10, coverage_days: 5, coefficient_enabled: true },
  });
  assert.equal(created.status, 201);
  const planId = created.body.data.plan.plan_id;
  assert.equal(created.body.data.plan.config.purchase_cycle_days, 10);

  const updated = await json(`/api/plans/${planId}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ plan_name: '方案4·改名' }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.plan.plan_name, '方案4·改名');

  // 参数校验：非法 plan_type / 非法数值
  const badType = await postJson('/api/plans', { plan_name: 'x', plan_type: 'nope' });
  assert.equal(badType.status, 400);
  assertErrorEnvelope(badType.body, 'VALIDATION_ERROR');
  assert.equal(badType.body.error.details.fields[0].field, 'plan_type');

  const badNumber = await postJson('/api/plans', {
    plan_name: 'x',
    plan_type: 'custom',
    config: { purchase_cycle_days: 0 },
  });
  assert.equal(badNumber.status, 400);
  assert.equal(badNumber.body.error.details.fields[0].field, 'config.purchase_cycle_days');

  const removed = await json(`/api/plans/${planId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);

  const systemDelete = await json('/api/plans/plan_avg', { method: 'DELETE' });
  assert.equal(systemDelete.status, 409);
  assertErrorEnvelope(systemDelete.body, 'CONFLICT');
});

test('建议：默认参数 / only_low / as_of + plan_id 透传 / 日期校验', async (t) => {
  const { json, queries } = await startTestServer(t);

  const plain = await json('/api/suggestions');
  assert.equal(plain.status, 200);
  const data = plain.body.data;
  for (const key of ['as_of', 'plan', 'formula_text', 'rows', 'kpi', 'total', 'page', 'page_size']) {
    assert.ok(key in data, `suggestions 缺少 ${key}`);
  }
  assert.equal(data.rows.length, 2);
  assert.equal(queries.seen.at(-1).only_low, false);

  const low = await json('/api/suggestions?only_low=true');
  assert.equal(low.status, 200);
  assert.equal(low.body.data.rows.length, 1);
  assert.equal(queries.seen.at(-1).only_low, true);

  const scoped = await json('/api/suggestions?as_of=2026-01-10&plan_id=plan_upper&page=1&page_size=10');
  assert.equal(scoped.status, 200);
  const opts = queries.seen.at(-1);
  assert.equal(opts.as_of, '2026-01-10');
  assert.equal(opts.plan_id, 'plan_upper');
  assert.equal(opts.page, 1);
  assert.equal(opts.page_size, 10);

  const badDate = await json('/api/suggestions?as_of=2026-02-31');
  assert.equal(badDate.status, 400);
  assertErrorEnvelope(badDate.body, 'VALIDATION_ERROR');
  assert.equal(badDate.body.error.details.fields[0].field, 'as_of');

  const badBool = await json('/api/suggestions?only_low=yes-please');
  assert.equal(badBool.status, 400);

  const badPage = await json('/api/suggestions?page=0');
  assert.equal(badPage.status, 400);
});

test('SKU 详情 / 库存列表：结构与分页', async (t) => {
  const { json } = await startTestServer(t);

  const detail = await json('/api/sku/SKU-001?as_of=2026-01-15');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.sku.sku_code, 'SKU-001');
  assert.equal(detail.body.data.inventory.sellable, 10);
  assert.ok(Array.isArray(detail.body.data.sales));
  assert.ok('explain' in detail.body.data);

  const missing = await json('/api/sku/SKU-NOPE');
  assert.equal(missing.status, 404);
  assertErrorEnvelope(missing.body, 'NOT_FOUND');

  const inventory = await json('/api/inventory');
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body.data.rows.length, 2);
  const first = inventory.body.data.rows[0];
  assert.equal(first.sku_code, 'SKU-001');
  assert.equal(first.on_hand, 12); // 库存四层原样拼平
  assert.equal(first.sellable, 10);

  const paged = await json('/api/inventory?page=2&page_size=1');
  assert.equal(paged.status, 200);
  assert.equal(paged.body.data.rows.length, 1);
  assert.equal(paged.body.data.rows[0].sku_code, 'SKU-002');
  assert.equal(paged.body.data.total, 2);
});

test('安全库存：GET 扁平 config / PUT 校验与保存', async (t) => {
  const { json } = await startTestServer(t);

  const got = await json('/api/safety-stock');
  assert.equal(got.status, 200);
  assert.equal(got.body.data.min_sellable_days, 3);
  assert.equal(got.body.data.mode, 'fixed');

  const put = await json('/api/safety-stock', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ min_sellable_days: 5, max_sellable_days: 20 }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.min_sellable_days, 5);

  const after = await json('/api/safety-stock');
  assert.equal(after.body.data.max_sellable_days, 20);

  const bad = await json('/api/safety-stock', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ min_sellable_days: -3 }),
  });
  assert.equal(bad.status, 400);
  assertErrorEnvelope(bad.body, 'VALIDATION_ERROR');
});

test('节假日：GET / POST / DELETE（query 与路径两种写法）', async (t) => {
  const { json, postJson } = await startTestServer(t);

  const list = await json('/api/holidays');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.holidays, ['2026-01-01']);

  const added = await postJson('/api/holidays', { date: '2026-05-01', name: '劳动节' });
  assert.equal(added.status, 201);
  assert.equal(added.body.data.holiday.date, '2026-05-01');

  const bad = await postJson('/api/holidays', { date: '2026-13-01' });
  assert.equal(bad.status, 400);
  assertErrorEnvelope(bad.body, 'VALIDATION_ERROR');

  const delQuery = await json('/api/holidays?date=2026-01-01', { method: 'DELETE' });
  assert.equal(delQuery.status, 200);
  assert.equal(delQuery.body.data.deleted, true);

  const delPath = await json('/api/holidays/2026-05-01', { method: 'DELETE' });
  assert.equal(delPath.status, 200);

  const empty = await json('/api/holidays');
  assert.deepEqual(empty.body.data.holidays, []);
});

test('POST /api/drafts：只产草稿（校验 kind/items），不提交', async (t) => {
  const repo = createStubRepo();
  const { json, postJson } = await startTestServer(t, { repo });

  const created = await postJson('/api/drafts', {
    kind: 'purchase',
    items: [
      { sku_code: 'SKU-001', apply_num: 12 },
      { sku_code: 'SKU-002', apply_num: 0 },
    ],
    expected_arrival: '2026-01-20',
    remark: '建议表一键生成',
    created_by: 'human',
  });
  assert.equal(created.status, 201);
  const draft = created.body.data.draft;
  assert.ok(draft.draft_id);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.items.length, 2);
  assert.equal(repo._orders.length, 0, '只产草稿，不能直接产生正式单');

  const listed = await json('/api/drafts');
  assert.equal(listed.body.data.drafts.length, 1);

  // kind 缺省为 purchase
  const defaultKind = await postJson('/api/drafts', {
    items: [{ sku_code: 'SKU-001', apply_num: 1 }],
  });
  assert.equal(defaultKind.status, 201);
  assert.equal(defaultKind.body.data.draft.kind, 'purchase');

  const badItems = await postJson('/api/drafts', { kind: 'purchase', items: [] });
  assert.equal(badItems.status, 400);
  assert.equal(badItems.body.error.details.fields[0].field, 'items');

  const badKind = await postJson('/api/drafts', {
    kind: 'transfer',
    items: [{ sku_code: 'SKU-001', apply_num: 1 }],
  });
  assert.equal(badKind.status, 400);

  const badNum = await postJson('/api/drafts', {
    kind: 'apply',
    items: [{ sku_code: 'SKU-001', apply_num: -2 }],
  });
  assert.equal(badNum.status, 400);
  assert.equal(badNum.body.error.details.fields[0].field, 'items[0].apply_num');

  const badDate = await postJson('/api/drafts', {
    kind: 'purchase',
    items: [{ sku_code: 'SKU-001', apply_num: 1 }],
    expected_arrival: '2026-02-31',
  });
  assert.equal(badDate.status, 400);
});

test('完整链路：草稿 → 审批 → 提交（含无审批/未通过审批被拒 + 幂等）', async (t) => {
  const repo = createStubRepo();
  const { json, postJson } = await startTestServer(t, { repo });

  const sessionResult = await postJson('/api/sessions', { title: '下单链路' });
  const sessionId = sessionResult.body.data.session_id;

  const draft = repo.createOrderDraft({}, {
    kind: 'purchase',
    items: [{ sku_code: 'SKU-001', apply_num: 12 }],
    expected_arrival: '2026-01-20',
    remark: '补货',
    session_id: sessionId,
  });

  const draftList = await json('/api/drafts');
  assert.equal(draftList.status, 200);
  assert.equal(draftList.body.data.drafts.length, 1);

  const draftDetail = await json(`/api/drafts/${draft.draft_id}`);
  assert.equal(draftDetail.status, 200);
  assert.equal(draftDetail.body.data.draft.draft_id, draft.draft_id);

  // 1) 审批不存在 → 404
  const noApproval = await postJson(`/api/drafts/${draft.draft_id}/commit`, { approval_id: 'appr_nope' });
  assert.equal(noApproval.status, 404);
  assertErrorEnvelope(noApproval.body, 'NOT_FOUND');

  // 2) 审批还是 pending → 409 APPROVAL_REQUIRED
  const approval = repo.createApproval({}, {
    session_id: sessionId,
    draft_id: draft.draft_id,
    kind: 'order_commit',
    summary: '提交采购单',
    risk: 'medium',
  });
  const pendingCommit = await postJson(`/api/drafts/${draft.draft_id}/commit`, {
    approval_id: approval.id,
  });
  assert.equal(pendingCommit.status, 409);
  assertErrorEnvelope(pendingCommit.body, 'APPROVAL_REQUIRED');
  assert.equal(pendingCommit.body.error.details.status, 'pending');

  // 3) 人在审批卡上点「批准」
  const approved = await postJson(`/api/sessions/${sessionId}/approvals/${approval.id}`, {
    decision: 'approve',
    note: '同意',
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.approval.status, 'approved');

  const approvalList = await json('/api/approvals?status=approved');
  assert.equal(approvalList.status, 200);
  assert.ok(approvalList.body.data.approvals.some((item) => item.id === approval.id));

  // 4) 提交成功
  const committed = await postJson(`/api/drafts/${draft.draft_id}/commit`, {
    approval_id: approval.id,
  });
  assert.equal(committed.status, 200);
  const order = committed.body.data.order;
  assert.ok(order);
  assert.equal(order.kind, 'purchase');
  assert.match(order.biz_no, /^PO/);
  assert.equal(order.status, 'committed');

  // 5) 幂等：重复提交返回同一单
  const again = await postJson(`/api/drafts/${draft.draft_id}/commit`, { approval_id: approval.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.order.order_id, order.order_id);

  const orders = await json('/api/orders?kind=purchase');
  assert.equal(orders.status, 200);
  assert.equal(orders.body.data.orders.length, 1);

  // 6) 重复处理审批 → 409 CONFLICT
  const doubleApprove = await postJson(`/api/sessions/${sessionId}/approvals/${approval.id}`, {
    decision: 'approve',
  });
  assert.equal(doubleApprove.status, 409);
  assertErrorEnvelope(doubleApprove.body, 'CONFLICT');

  // 7) 非法决策 → 400
  const badDecision = await postJson(`/api/sessions/${sessionId}/approvals/${approval.id}`, {
    decision: 'maybe',
  });
  assert.equal(badDecision.status, 400);
});

test('审计：写入后可按会话/类型/limit 查询', async (t) => {
  const repo = createStubRepo();
  const { json } = await startTestServer(t, { repo });

  repo.appendAudit({}, {
    session_id: 'sess_a',
    actor: 'agent',
    kind: 'tool_call',
    tool: 'inventory.get',
    payload: { sku_code: 'SKU-001' },
    ok: true,
    duration_ms: 3,
  });
  repo.appendAudit({}, {
    session_id: 'sess_b',
    actor: 'scheduler',
    kind: 'draft_created',
    payload: {},
    ok: true,
    duration_ms: 8,
  });

  const all = await json('/api/audit?limit=10');
  assert.equal(all.status, 200);
  assert.equal(all.body.data.events.length, 2);

  const bySession = await json('/api/audit?session_id=sess_a');
  assert.equal(bySession.body.data.events.length, 1);
  assert.equal(bySession.body.data.events[0].tool, 'inventory.get');

  const byKind = await json('/api/audit?kind=draft_created');
  assert.equal(byKind.body.data.events.length, 1);

  const badLimit = await json('/api/audit?limit=9999');
  assert.equal(badLimit.status, 400);
});

test('定时任务：列表 + 手动触发 + 不存在 404', async (t) => {
  const { json, postJson, scheduler } = await startTestServer(t);

  const list = await json('/api/schedules');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.schedules.length, 1);
  assert.equal(list.body.data.schedules[0].id, 'sch_001');

  const run = await postJson('/api/schedules/sch_001/run', {});
  assert.equal(run.status, 200);
  assert.equal(run.body.data.result.run_id, 'run_001');
  assert.deepEqual(scheduler.runs, ['sch_001']);

  const missing = await postJson('/api/schedules/sch_nope/run', {});
  assert.equal(missing.status, 404);
  assertErrorEnvelope(missing.body, 'NOT_FOUND');
});

test('/api/meta 与 /api/assumptions：元数据与假设清单', async (t) => {
  const { json } = await startTestServer(t);

  const meta = await json('/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.data.today, '2026-01-15');
  assert.equal(meta.body.data.stores.length, 1);
  assert.equal(meta.body.data.plans.length, 2);
  assert.ok(meta.body.data.counts.sku >= 1);

  const assumptions = await json('/api/assumptions');
  assert.equal(assumptions.status, 200);
  assert.equal(assumptions.body.data.assumptions[0].id, 'H1');
});

test('域层错误（DomainError 形状）被映射成契约错误码与状态', async (t) => {
  const repo = createStubRepo();
  // 让 listPlans 抛 DATA_MISSING / STALE_DATA 验证映射
  repo.listPlans = () => {
    throw Object.assign(new Error('销量数据缺失'), { code: 'DATA_MISSING', details: { sku_code: 'SKU-001' } });
  };
  const { json } = await startTestServer(t, { repo });

  const res = await json('/api/plans');
  assert.equal(res.status, 422);
  assertErrorEnvelope(res.body, 'DATA_MISSING');
  assert.equal(res.body.error.details.sku_code, 'SKU-001');

  repo.listPlans = () => {
    throw Object.assign(new Error('数据过期'), { code: 'STALE_DATA' });
  };
  const stale = await json('/api/plans');
  assert.equal(stale.status, 422);
  assertErrorEnvelope(stale.body, 'STALE_DATA');
});
