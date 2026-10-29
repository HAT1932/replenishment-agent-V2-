/**
 * tools.test.mjs — 工具注册表：schema / 参数校验 / 审计截断 / 审批 / 真实 domain 计算
 * 自测：node --test test/agent
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/fixtures.mjs';

test('注册表：schema 名字转 domain__action，事件/审计用契约原名', async () => {
  const h = createHarness();
  const schema = h.tools.toModelTools();
  const names = schema.map((t) => t.function.name);
  assert.ok(names.includes('catalog__list_skus'));
  assert.ok(names.includes('suggestion__compute'));
  assert.ok(names.includes('order__commit'));
  assert.ok(!names.some((n) => n.includes('.')), 'OpenAI function name 不允许点号');

  assert.equal(h.tools.canonicalName('catalog__list_skus'), 'catalog.list_skus');
  assert.equal(h.tools.canonicalName('catalog.list_skus'), 'catalog.list_skus');
  assert.equal(h.tools.canonicalName('nope__tool'), null);

  const unknown = await h.tools.execute('nope.tool', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'NOT_FOUND');
});

test('参数校验：未知参数 / 类型错误 → VALIDATION_ERROR，且失败写审计', async () => {
  const h = createHarness();
  const bad = await h.tools.execute('catalog.list_skus', { bogus: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'VALIDATION_ERROR');

  const badType = await h.tools.execute('catalog.list_skus', { limit: 'abc' });
  assert.equal(badType.ok, false);
  assert.equal(badType.error.code, 'VALIDATION_ERROR');

  const results = h.repository.state.audits.filter((a) => a.kind === 'tool_result');
  assert.equal(results.length, 2);
  assert.ok(results.every((a) => a.ok === false));
});

test('审计 payload 截断到 2KB（入参与结果都要截断）', async () => {
  const echoTool = {
    name: 'test.echo',
    description: '测试用回显工具',
    provenance: 'assumption',
    parameters: { type: 'object', properties: { payload: { type: 'string' } }, additionalProperties: false },
    async execute(args) {
      return { payload: args.payload };
    },
  };
  const h = createHarness({ extraTools: [echoTool] });
  const big = 'x'.repeat(5000);
  const result = await h.tools.execute('test.echo', { payload: big });
  assert.equal(result.ok, true);

  const callAudit = h.repository.state.audits.find((a) => a.kind === 'tool_call');
  const resultAudit = h.repository.state.audits.find((a) => a.kind === 'tool_result');
  assert.equal(callAudit.payload.args.truncated, true);
  assert.ok(JSON.stringify(callAudit.payload.args).length <= 2100);
  assert.equal(resultAudit.payload.result.truncated, true);
  assert.ok(JSON.stringify(resultAudit.payload.result).length <= 2100);
});

test('suggestion.compute：数字来自 domain，provenance/assumptions 透传，KPI 用 domain.summarize', async () => {
  const h = createHarness();
  const res = await h.tools.execute('suggestion.compute', { plan_id: 'plan_default' });
  assert.equal(res.ok, true);
  const { rows, kpi, plan } = res.data;
  assert.equal(plan.plan_id, 'plan_default');
  assert.equal(rows.length, 2); // SP003 无库存快照被跳过（不按 0 库存处理）
  const row = rows.find((r) => r.sku_code === 'SP001');
  assert.equal(row.suggest_num, 20);
  assert.equal(row.stock_lower, 10);
  assert.equal(row.avg_daily_sales_exact, 10 / 15);
  assert.equal(row.provenance, 'documented');
  assert.ok(row.assumptions.includes('H1') && row.assumptions.includes('H4'));
  // KPI 来自 domain.summarize（按 apply_num 汇总：SP001 20 + SP002 30）
  assert.equal(kpi.total_suggest_qty, 50);
  assert.equal(kpi.low_stock_alert_count, 2);
  assert.ok(rows.some((r) => r.flags.includes('stale_data')), 'SP002 应标记 stale_data');
  assert.deepEqual(res.data.skipped.map((s) => s.sku_code), ['SP003']);
  assert.equal(res.data.skipped[0].code, 'DATA_MISSING');

  // meta 溯源三件套 + artifact
  assert.equal(res.meta.provenance, 'documented');
  assert.ok(res.meta.assumptions.includes('H1'));
  assert.equal(res.meta.as_of, '2026-10-29');
  assert.equal(res.meta.artifacts[0].kind, 'suggestions');
  assert.equal(res.meta.artifacts[0].ref.plan_id, 'plan_default');
});

test('suggestion.compute only_low 过滤 + suggestion.explain 复用域层解释', async () => {
  const h = createHarness();
  const low = await h.tools.execute('suggestion.compute', { plan_id: 'plan_default', only_low: true });
  assert.equal(low.ok, true);
  assert.ok(low.data.rows.length >= 1);
  assert.ok(low.data.rows.every((r) => r.guard.alert === true));

  const explain = await h.tools.execute('suggestion.explain', { sku_code: 'SP001' });
  assert.equal(explain.ok, true);
  assert.equal(explain.data.sku_code, 'SP001');
  assert.equal(explain.data.suggest_raw_exact, 20);
  assert.equal(explain.data.suggest_num, 20);
  assert.ok(Array.isArray(explain.data.steps) && explain.data.steps.length >= 4, '应返回 why 步骤');
  assert.equal(explain.data.plan.plan_type, 'avg_daily');
  assert.ok(explain.data.assumptions.includes('H1'));
});

test('order.create_draft：只产草稿 + 自动审批请求，绝不下单', async () => {
  const h = createHarness();
  const res = await h.tools.execute('order.create_draft', {
    kind: 'purchase',
    items: [{ sku_code: 'SP001', apply_num: 20 }],
    expected_arrival: '2026-11-05',
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.status, 'draft');
  assert.equal(res.data.total_qty, 20);
  assert.equal(res.data.total_amount, 440); // 20 × 22
  assert.equal(res.data.approval.status, 'pending');
  assert.equal(res.data.approval.kind, 'order_commit');
  assert.equal(res.meta.approval.id, res.data.approval.id);
  assert.ok(res.meta.artifacts.some((a) => a.kind === 'draft'));

  assert.equal(h.repository.state.orders.length, 0, '草稿绝不等于正式单');
  assert.equal(h.repository.state.approvals.length, 1);
  assert.equal(h.repository.state.approvals[0].draft_id, res.data.draft_id);
  // 审计里 dry 标记：写操作 dry=false
  const callAudit = h.repository.state.audits.find((a) => a.kind === 'tool_call');
  assert.equal(callAudit.payload.dry, false);
  assert.equal(callAudit.actor, 'agent');
});

test('只读工具返回真实 domain 结果（catalog / inventory / demand / safety / plan / assumption / audit / schedule）', async () => {
  const h = createHarness();

  const catalog = await h.tools.execute('catalog.list_skus', { limit: 2 });
  assert.equal(catalog.ok, true);
  assert.equal(catalog.data.skus.length, 2);
  assert.equal(catalog.data.skus[0].sku_code, 'SP001');

  const inv = await h.tools.execute('inventory.get', { sku_code: 'SP001' });
  assert.equal(inv.ok, true);
  assert.equal(inv.data.sellable, 0);
  assert.equal(inv.data.status, 'ok');

  const demand = await h.tools.execute('demand.window', { sku_code: 'SP001' });
  assert.equal(demand.ok, true);
  assert.equal(demand.data.days, 15);
  assert.equal(demand.data.avg_daily_exact, 10 / 15);
  assert.equal(demand.data.status, 'ok');

  const safety = await h.tools.execute('safety.resolve', { sku_code: 'SP001' });
  assert.equal(safety.ok, true);
  assert.equal(safety.data.mode, 'fixed');
  assert.equal(safety.data.lower, 10);
  assert.equal(safety.data.upper, 100);

  const plans = await h.tools.execute('plan.list', {});
  assert.equal(plans.ok, true);
  assert.equal(plans.data.plans[0].plan_id, 'plan_default');
  assert.equal(plans.data.plans[0].formula_text, '建议数量 = 近15天日均销量 × 可售天数 + 库存预警下限 − 可售库存');

  const assumptions = await h.tools.execute('assumption.list', {});
  assert.equal(assumptions.ok, true);
  assert.ok(assumptions.data.assumptions.some((a) => a.id === 'H1'));

  const schedules = await h.tools.execute('schedule.list', {});
  assert.equal(schedules.ok, true);
  assert.equal(schedules.data.schedules[0].cadence, 'daily@09:00');

  const audit = await h.tools.execute('audit.search', { limit: 10 });
  assert.equal(audit.ok, true);
  assert.ok(audit.data.events.length >= 1);
});

test('schedule.trigger：手动触发只产草稿 + 通知，不自动提交', async () => {
  const h = createHarness();
  const res = await h.tools.execute('schedule.trigger', { schedule_id: 'sch_1' });
  assert.equal(res.ok, true);
  assert.equal(res.data.draft_ids.length, 1);
  assert.equal(res.data.approval_ids.length, 1);
  assert.equal(res.data.notifications.length, 1);
  assert.equal(res.data.notifications[0].channel, 'inbox');
  assert.match(res.data.summary, /等待人工审批/);
  assert.equal(h.repository.state.orders.length, 0, '定时任务永不自动提交');
  assert.equal(h.repository.state.drafts.length, 1);
  const scheduleRunAudit = h.repository.state.audits.find((a) => a.kind === 'schedule_run');
  assert.ok(scheduleRunAudit);
  assert.equal(scheduleRunAudit.actor, 'scheduler');
  // 工具级审计 actor 也应是 scheduler（排除最外层 schedule.trigger 自身）
  const toolAudit = h.repository.state.audits.find(
    (a) => a.kind === 'tool_call' && a.tool === 'suggestion.compute',
  );
  assert.equal(toolAudit.actor, 'scheduler');
});

test('schedule.trigger 未知 id → NOT_FOUND', async () => {
  const h = createHarness();
  const res = await h.tools.execute('schedule.trigger', { schedule_id: 'sch_missing' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NOT_FOUND');
});
