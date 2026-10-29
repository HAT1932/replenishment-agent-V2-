import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../server/data/db.mjs';
import * as repo from '../../server/data/repository.mjs';
import { buildSuggestions, getSkuDetail } from '../../server/data/queries.mjs';

const AS_OF = '2026-10-29';
const db = openDb(':memory:', { endDate: AS_OF, seed: true });

test('播种：演示数据完整且带「脏数据」用于验证口径', () => {
  const meta = repo.getMeta(db);
  assert.equal(meta.today, AS_OF);
  assert.equal(meta.counts.store, 2);
  assert.ok(meta.counts.sku >= 40, `sku=${meta.counts.sku}`);
  assert.equal(meta.counts.sales_days, 90);
  assert.equal(meta.plans.length, 4);
  assert.equal(meta.plans[0].is_system, true, '前两个是系统默认方案');
  assert.ok(meta.plans[0].formula_text.includes('近15天日均销量'), '公式文案与官方一致');
  assert.ok(meta.data_quality.skus_with_missing_days >= 1, '必须存在缺日 SKU');
  assert.ok(meta.data_quality.skus_with_stale_snapshot >= 1, '必须存在过期快照');
  assert.ok(meta.data_quality.skus_oversold >= 1, '必须存在超卖 SKU');
});

test('批量建议：KPI 在服务端算，分页不改变 KPI', () => {
  const full = buildSuggestions(db, { plan_id: 1, as_of: AS_OF, page: 1, page_size: 200 });
  assert.ok(full.total > 0);
  assert.equal(full.kpi.row_count, full.total);
  assert.equal(full.rows.length, Math.min(200, full.total));
  assert.ok(full.formula_text.includes('库存预警下限'));
  assert.ok(full.guard_note.includes('低库存预警'));

  const page2 = buildSuggestions(db, { plan_id: 1, as_of: AS_OF, page: 2, page_size: 5 });
  assert.equal(page2.kpi.row_count, full.kpi.row_count, '翻页不改变 KPI');
  assert.equal(page2.rows.length <= 5, true);
  assert.equal(page2.total_pages, Math.ceil(full.total / 5));
});

test('D1 在真实数据上可见：缺日 SKU 的窗口标记 imputed_days', () => {
  const all = buildSuggestions(db, { plan_id: 1, as_of: AS_OF, page: 1, page_size: 200, only_low: false });
  const gapped = all.rows.filter((r) => (r.demand_window?.imputed_days ?? 0) > 0);
  assert.ok(gapped.length >= 1, '演示数据应包含缺日 SKU');
  for (const row of gapped) {
    // 日均必须 = 窗口总量 / 15（含补零），而不是「最后 15 条记录」的均值
    assert.ok(Math.abs(row.avg_daily_sales_exact - row.demand_window.total / 15) < 1e-9);
  }
});

test('闸门与 only_low 过滤一致', () => {
  const all = buildSuggestions(db, { plan_id: 1, as_of: AS_OF, page: 1, page_size: 200, only_low: false });
  const low = buildSuggestions(db, { plan_id: 1, as_of: AS_OF, page: 1, page_size: 200, only_low: true });
  assert.ok(low.total <= all.total);
  assert.ok(low.rows.every((r) => r.guard.alert === true));
});

test('过期快照 → stale_data 标记；超卖 → 负可售标记', () => {
  const all = buildSuggestions(db, { plan_id: 1, as_of: AS_OF, page: 1, page_size: 200, only_low: false });
  const stale = all.rows.filter((r) => r.flags.includes('stale_data'));
  assert.ok(stale.length >= 1, '应识别出过期数据');
  const neg = all.rows.filter((r) => r.flags.includes('negative_sellable'));
  assert.ok(neg.length >= 1, '应识别出超卖');
  assert.ok(neg[0].sellable_stock < 0);
});

test('方案 4（σ 增强）与三个文档方案都能算，且 provenance 不混淆', () => {
  for (const planId of [1, 2, 3, 4]) {
    const r = buildSuggestions(db, { plan_id: planId, as_of: AS_OF, page: 1, page_size: 20 });
    assert.ok(r.total > 0, `plan ${planId} 应有结果`);
    const expected = planId === 4 ? 'enhancement' : 'documented';
    assert.equal(r.rows[0].provenance, expected, `plan ${planId}`);
  }
});

test('SKU 详情：四层下钻数据齐备', () => {
  const sku = repo.listSkus(db, { limit: 1 })[0];
  const detail = getSkuDetail(db, sku.code, { as_of: AS_OF });
  assert.equal(detail.sku.sku_code, sku.code);
  assert.equal(detail.series.length, 90);
  assert.equal(detail.suggestions.length, 4, '四个方案各一条建议');
  assert.ok(detail.explain, '必须带解释链');
  assert.ok(detail.explain.steps.length >= 5);
});

test('审批闸门：无审批不能提交；批准后可提交；重复提交幂等', () => {
  const sku = repo.listSkus(db, { limit: 1 })[0];
  const draft = repo.createOrderDraft(db, {
    kind: 'purchase',
    items: [{ sku_code: sku.code, apply_num: 12 }],
    expected_arrival: '2026-11-05',
    remark: '测试草稿',
    created_by: 'test',
  });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.total_qty, 12);
  assert.ok(draft.total_amount > 0);

  // 未审批直接提交 → APPROVAL_REQUIRED
  assert.throws(
    () => repo.commitDraft(db, draft.id, { approval_id: null }),
    (e) => e.code === 'APPROVAL_REQUIRED',
  );

  const approval = repo.createApproval(db, {
    draft_id: draft.id,
    summary: { draft_id: draft.id, total_qty: 12 },
    risk: 'medium',
  });
  // 审批未处理时提交 → 拒绝
  assert.throws(() => repo.commitDraft(db, draft.id, { approval_id: approval.id }), (e) => e.code === 'APPROVAL_REQUIRED');

  repo.resolveApproval(db, approval.id, { decision: 'approve', note: '同意补货' });
  const order = repo.commitDraft(db, draft.id, { approval_id: approval.id, operator: '张三' });
  assert.match(order.biz_no, /^CG\d{8}\d{4}$/);
  assert.equal(order.status, '待审核');
  assert.equal(repo.getDraft(db, draft.id).status, 'committed');

  // 幂等：再次提交返回同一单
  const again = repo.commitDraft(db, draft.id, { approval_id: approval.id });
  assert.equal(again.id, order.id);
  assert.equal(again.idempotent, true);
});

test('审批：驳回后草稿不可提交', () => {
  const sku = repo.listSkus(db, { limit: 1 })[0];
  const draft = repo.createOrderDraft(db, { kind: 'apply', items: [{ sku_code: sku.code, apply_num: 3 }], created_by: 'test' });
  const approval = repo.createApproval(db, { draft_id: draft.id, summary: {} });
  repo.resolveApproval(db, approval.id, { decision: 'reject', note: '数量不合理' });
  assert.throws(() => repo.commitDraft(db, draft.id, { approval_id: approval.id }), (e) => e.code === 'APPROVAL_REQUIRED');
});

test('系统默认方案可改不可删；自定义方案可删', () => {
  const system = repo.getPlan(db, 1);
  assert.equal(system.is_system, true);
  const updated = repo.updatePlan(db, 1, { plan_name: '按日均销量补货（改名）' });
  assert.equal(updated.plan_name, '按日均销量补货（改名）');
  assert.throws(() => repo.deletePlan(db, 1), (e) => e.code === 'CONFLICT');

  const created = repo.createPlan(db, { plan_name: '测试方案', plan_type: 'avg_daily', config: { plan_type: 'avg_daily', coverage_days: 10 } });
  assert.equal(created.is_system, false);
  assert.deepEqual(repo.deletePlan(db, created.plan_id), { deleted: true, plan_id: created.plan_id });
});

test('审计：写入可查、payload 截断、按时间倒序', () => {
  const before = repo.searchAudit(db, { limit: 500 }).length;
  repo.appendAudit(db, { session_id: 's1', actor: 'agent', kind: 'tool_call', tool: 'inventory.get', payload: { a: 1 }, ok: true, duration_ms: 12, provenance: 'documented' });
  repo.appendAudit(db, { session_id: 's1', actor: 'agent', kind: 'tool_result', tool: 'inventory.get', payload: 'x'.repeat(5000), ok: false });
  repo.appendAudit(db, { session_id: 's2', actor: 'agent', kind: 'tool_result', tool: 'big', payload: { blob: 'y'.repeat(8000) } });
  const rows = repo.searchAudit(db, { session_id: 's1', limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ok, false, '倒序：最新在前');
  assert.equal(typeof rows[0].payload, 'string');
  assert.ok(rows[0].payload.endsWith('…'), '超长字符串先截断，落库仍是合法 JSON');
  assert.equal(rows[1].payload.a, 1);

  const big = repo.searchAudit(db, { session_id: 's2', limit: 1 })[0];
  assert.equal(big.payload.truncated, true, '超大对象落库标记截断');
  assert.ok(big.payload.preview.length > 0);
  assert.equal(repo.searchAudit(db, { limit: 500 }).length, before + 3);
});

test('会话 / 消息 / 产物：序贯通增、删除级联', () => {
  const session = repo.createSession(db, { title: '测试会话' });
  repo.appendMessage(db, { session_id: session.id, role: 'user', content: { text: '你好' } });
  repo.appendMessage(db, { session_id: session.id, role: 'assistant', content: { text: '在' } });
  const messages = repo.listMessages(db, session.id);
  assert.deepEqual(messages.map((m) => m.seq), [1, 2]);
  const artifact = repo.saveArtifact(db, { session_id: session.id, kind: 'suggestions', title: '建议', content: { rows: [] } });
  assert.equal(repo.listArtifacts(db, session.id).length, 1);
  assert.equal(repo.getArtifact(db, artifact.id).content.rows.length, 0);
  repo.deleteSession(db, session.id);
  assert.equal(repo.getSession(db, session.id), null);
  assert.equal(repo.listMessages(db, session.id).length, 0);
});

test('节假日与预警配置可改', () => {
  const dates = repo.getHolidayDates(db);
  assert.ok(dates.length >= 2);
  repo.addHoliday(db, { date: '2026-12-24', name: '平安夜（示例）' });
  assert.ok(repo.getHolidayDates(db).includes('2026-12-24'));
  repo.removeHoliday(db, '2026-12-24');
  assert.ok(!repo.getHolidayDates(db).includes('2026-12-24'));

  const cfg = repo.saveSafetyConfig(db, { mode: 'fixed', lower_fixed: 20, upper_fixed: 200 });
  assert.equal(cfg.mode, 'fixed');
  assert.equal(cfg.lower_fixed, 20);
  repo.saveSafetyConfig(db, { mode: 'dynamic', min_sellable_days: 7, max_sellable_days: 30 });
});
