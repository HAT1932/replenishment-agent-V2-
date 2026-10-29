/**
 * runtime.test.mjs — 运行时多步循环 / 审批闸门 / 预算 / 审计 / usage
 * 自测：node --test test/agent
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHarness,
  runTurn,
  mainTypes,
  eventsOfType,
  toolCallNames,
  sleep,
} from './helpers/fixtures.mjs';
import {
  MAX_STEPS,
  MAX_TOOL_CALLS_PER_TURN,
  TOOL_TIMEOUT_MS,
  TURN_BUDGET_MS,
} from '../../server/agent/runtime.mjs';

const SESSION = 'sess_runtime_1';

test('mock 多步主流程：list_skus → inventory.get → suggestion.compute → create_draft → approval_required →（批准后）commit → done', async () => {
  const h = createHarness();
  const first = await runTurn(h.runtime, { sessionId: SESSION, message: '帮我看看哪些 SKU 需要补货，并生成采购草稿' });

  // 事件协议：seq 单调递增，首事件 session，末事件 done
  assert.equal(first.events[0].type, 'session');
  assert.equal(first.events[0].session_id, SESSION);
  first.events.forEach((event, index) => assert.equal(event.seq, index + 1, 'seq 必须单调递增且无空洞'));
  assert.equal(first.events.at(-1).type, 'done');

  // 工具调用顺序
  assert.deepEqual(toolCallNames(first.events), [
    'catalog.list_skus',
    'inventory.get',
    'suggestion.compute',
    'order.create_draft',
  ]);

  // 建议 artifact + 草稿 artifact + 审批卡
  const artifacts = eventsOfType(first.events, 'artifact').map((e) => e.artifact);
  assert.ok(artifacts.some((a) => a.kind === 'suggestions'), '应有建议表 artifact');
  assert.ok(artifacts.some((a) => a.kind === 'draft'), '应有草稿 artifact');
  const approvals = eventsOfType(first.events, 'approval_required');
  assert.equal(approvals.length, 1, 'create_draft 后必须发 approval_required');
  assert.equal(approvals[0].approval.kind, 'order_commit');
  assert.equal(approvals[0].approval.risk, 'medium');
  assert.equal(approvals[0].approval.ref.draft_id, 'draft_1');

  // 建议数字来自 domain（SP001：日均 10/15、固定下限 10 → 建议 20）
  const suggestionEvent = eventsOfType(first.events, 'tool_result').find((e) => e.name === 'suggestion.compute');
  assert.equal(suggestionEvent.ok, true);
  assert.equal(suggestionEvent.data.rows[0].suggest_num, 20);
  assert.equal(suggestionEvent.data.rows[0].provenance, 'documented');
  assert.ok(suggestionEvent.data.rows[0].assumptions.includes('H1'));

  // 审计：4 次工具调用 × (tool_call + tool_result) = 8 条
  const toolAudits = h.repository.state.audits.filter((a) => a.kind === 'tool_call' || a.kind === 'tool_result');
  assert.equal(toolAudits.length, 8, '每次工具调用必须成功+失败都写审计');
  assert.equal(toolAudits.filter((a) => a.kind === 'tool_call').length, 4);
  assert.equal(toolAudits.filter((a) => !a.ok).length, 0);
  assert.equal(h.repository.state.orders.length, 0, '第一轮绝不能产生正式单');

  // usage 汇总（mock 每步固定 100/20/5，共 4 步）
  const usage = eventsOfType(first.events, 'usage').at(-1);
  assert.deepEqual(
    { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, reasoning_tokens: usage.reasoning_tokens },
    { prompt_tokens: 400, completion_tokens: 80, reasoning_tokens: 20 },
  );
  assert.deepEqual(first.result.usage, {
    prompt_tokens: 400,
    completion_tokens: 80,
    reasoning_tokens: 20,
  });
  assert.equal(first.result.finish_reason, 'stop');
  assert.equal(first.result.steps, 4);

  // ---- 人工审批后提交 ----
  const approvalId = approvals[0].approval.id;
  await h.repository.resolveApproval(h.db, approvalId, { decision: 'approve', operator: 'human' });
  const second = await runTurn(h.runtime, { sessionId: SESSION, message: '已批准，提交订单' });

  assert.deepEqual(toolCallNames(second.events), ['order.commit']);
  const commitEvent = eventsOfType(second.events, 'tool_result').find((e) => e.name === 'order.commit');
  assert.equal(commitEvent.ok, true);
  assert.equal(commitEvent.data.status, 'committed');
  assert.equal(h.repository.state.orders.length, 1);
  assert.equal(h.repository.state.orders[0].approval_id, approvalId);
  assert.equal(h.repository.state.drafts[0].status, 'committed');
  assert.equal(second.result.finish_reason, 'stop');
  // 第二轮新增 2 条工具审计 → 共 10 条
  assert.equal(
    h.repository.state.audits.filter((a) => a.kind === 'tool_call' || a.kind === 'tool_result').length,
    10,
  );
});

test('无有效审批的 commit 被工具层直接拒绝（APPROVAL_REQUIRED），不交给模型判断', async () => {
  const h = createHarness();
  // 先造一个真实草稿 + pending 审批
  const draft = await h.tools.execute('order.create_draft', {
    kind: 'purchase',
    items: [{ sku_code: 'SP001', apply_num: 5 }],
  });
  assert.equal(draft.ok, true);
  const draftId = draft.data.draft_id;
  const approvalId = draft.data.approval.id;

  // 1) 审批不存在
  const missing = await h.tools.execute('order.commit', { draft_id: draftId, approval_id: 'apr_missing' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'APPROVAL_REQUIRED');

  // 2) 审批仍是 pending
  const pending = await h.tools.execute('order.commit', { draft_id: draftId, approval_id: approvalId });
  assert.equal(pending.ok, false);
  assert.equal(pending.error.code, 'APPROVAL_REQUIRED');

  // 3) 审批与草稿不匹配
  const otherDraft = await h.tools.execute('order.create_draft', {
    kind: 'purchase',
    items: [{ sku_code: 'SP001', apply_num: 1 }],
  });
  const mismatch = await h.tools.execute('order.commit', {
    draft_id: otherDraft.data.draft_id,
    approval_id: approvalId,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, 'APPROVAL_REQUIRED');

  // 4) 全部失败时绝不产生正式单，且失败也写审计
  assert.equal(h.repository.state.orders.length, 0);
  const failedAudits = h.repository.state.audits.filter((a) => a.kind === 'tool_result' && !a.ok);
  assert.equal(failedAudits.length, 3);
  assert.equal(failedAudits[0].payload.error.code, 'APPROVAL_REQUIRED');

  // 5) 批准后同一 approval_id 才能提交
  await h.repository.resolveApproval(h.db, approvalId, { decision: 'approve' });
  const committed = await h.tools.execute('order.commit', { draft_id: draftId, approval_id: approvalId });
  assert.equal(committed.ok, true);
  assert.equal(committed.data.status, 'committed');
  assert.equal(h.repository.state.orders.length, 1);
});

test('工具抛 DomainError：tool_result.ok=false + 错误码映射，不中断整轮', async () => {
  const h = createHarness({
    script: [
      { reasoning: '取库存', tool_calls: [{ name: 'inventory.get', args: { sku_code: 'SP003' } }] },
      { content: 'SP003 没有库存快照，已如实说明，不编造数字。' },
    ],
  });
  const { events, result } = await runTurn(h.runtime, { sessionId: 'sess_err', message: '看看 SP003 的库存' });

  const toolResults = eventsOfType(events, 'tool_result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].ok, false);
  assert.equal(toolResults[0].error.code, 'DATA_MISSING');
  assert.equal(result.finish_reason, 'stop', '单工具失败不应中断整轮');
  const failedAudit = h.repository.state.audits.find((a) => a.kind === 'tool_result' && !a.ok);
  assert.ok(failedAudit, '失败调用必须写审计');
  assert.equal(failedAudit.payload.error.code, 'DATA_MISSING');
});

test('工具超时：20s 预算可注入缩小，超时错误 + 审计记录 + 正常收尾', async () => {
  const slowTool = {
    name: 'test.slow',
    description: '测试用慢工具',
    provenance: 'assumption',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      await sleep(500);
      return { done: true };
    },
  };
  const h = createHarness({
    extraTools: [slowTool],
    limits: { toolTimeoutMs: 20 },
    script: [
      { tool_calls: [{ name: 'test.slow', args: {} }] },
      { content: '工具超时已如实反馈。' },
    ],
  });
  const { events, result } = await runTurn(h.runtime, { sessionId: 'sess_timeout', message: '跑个慢工具' });
  const toolResult = eventsOfType(events, 'tool_result')[0];
  assert.equal(toolResult.ok, false);
  assert.equal(toolResult.error.code, 'TOOL_TIMEOUT');
  assert.equal(result.finish_reason, 'stop');
  const failed = h.repository.state.audits.find((a) => a.kind === 'tool_result' && !a.ok);
  assert.ok(failed);
  assert.equal(failed.payload.error.code, 'TOOL_TIMEOUT');
});

test('超出 MAX_STEPS：发 error 事件后正常收尾（不抛未捕获异常）', async () => {
  const pingTool = {
    name: 'test.ping',
    description: '测试用无副作用工具',
    provenance: 'assumption',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { pong: true };
    },
  };
  const h = createHarness({
    extraTools: [pingTool],
    limits: { maxSteps: 3 },
    script: () => ({ tool_calls: [{ name: 'test.ping', args: {} }] }),
  });
  const { events, result } = await runTurn(h.runtime, { sessionId: 'sess_steps', message: '无限工具循环' });

  const errors = eventsOfType(events, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'MAX_STEPS_EXCEEDED');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(result.finish_reason, 'max_steps');
  assert.equal(eventsOfType(events, 'tool_call').length, 3);

  // 契约常量不可悄悄变小
  assert.equal(MAX_STEPS, 8);
  assert.equal(MAX_TOOL_CALLS_PER_TURN, 12);
  assert.equal(TOOL_TIMEOUT_MS, 20000);
  assert.equal(TURN_BUDGET_MS, 180000);
});

test('单轮工具调用超过上限：TOOL_CALL_BUDGET_EXCEEDED + done', async () => {
  const pingTool = {
    name: 'test.ping',
    description: '测试用无副作用工具',
    provenance: 'assumption',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { pong: true };
    },
  };
  const h = createHarness({
    extraTools: [pingTool],
    limits: { maxToolCallsPerTurn: 4 },
    script: () => ({
      tool_calls: [
        { name: 'test.ping', args: {} },
        { name: 'test.ping', args: {} },
        { name: 'test.ping', args: {} },
      ],
    }),
  });
  const { events, result } = await runTurn(h.runtime, { sessionId: 'sess_budget', message: '并行调用很多工具' });
  const error = eventsOfType(events, 'error')[0];
  assert.equal(error.code, 'TOOL_CALL_BUDGET_EXCEEDED');
  assert.equal(result.finish_reason, 'tool_budget');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(eventsOfType(events, 'tool_call').length, 4);
});

test('整轮预算耗尽：TURN_BUDGET_EXCEEDED + done', async () => {
  const waitTool = {
    name: 'test.wait',
    description: '测试用等待工具',
    provenance: 'assumption',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      await sleep(80);
      return { waited: true };
    },
  };
  const h = createHarness({
    clock: () => Date.now(), // 真实时钟：预算断言需要真实耗时
    extraTools: [waitTool],
    limits: { turnBudgetMs: 30, toolTimeoutMs: 1000 },
    script: [{ tool_calls: [{ name: 'test.wait', args: {} }] }, { content: '预算耗尽，请人工继续。' }],
  });
  const { events, result } = await runTurn(h.runtime, { sessionId: 'sess_turn_budget', message: '跑很久' });
  const error = eventsOfType(events, 'error')[0];
  assert.equal(error.code, 'TURN_BUDGET_EXCEEDED');
  assert.equal(result.finish_reason, 'turn_budget');
});

test('Provider 失败：发 error 事件并结束，不伪造结果', async () => {
  const brokenProvider = {
    name: 'broken',
    model: 'broken-1',
    supportsStreaming: false,
    async chat() {
      const err = new Error('upstream down');
      err.code = 'UPSTREAM_LLM_ERROR';
      throw err;
    },
  };
  const h = createHarness({ provider: brokenProvider });
  const { events, result } = await runTurn(h.runtime, { sessionId: 'sess_provider_err', message: '你好' });
  const error = eventsOfType(events, 'error')[0];
  assert.equal(error.code, 'UPSTREAM_LLM_ERROR');
  assert.equal(result.finish_reason, 'error');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(h.repository.state.audits.length, 0, 'Provider 失败不应产生工具审计');
});

test('reasoning_content 独立流式：reasoning_delta 与 assistant_delta 分开', async () => {
  const h = createHarness({ script: [{ reasoning: '先想一想口径', content: '结论：需要补货。' }] });
  const { events } = await runTurn(h.runtime, { sessionId: 'sess_delta', message: '说说思路' });
  const reasoning = eventsOfType(events, 'reasoning_delta').map((e) => e.text).join('');
  const assistant = eventsOfType(events, 'assistant_delta').map((e) => e.text).join('');
  assert.equal(reasoning, '先想一想口径');
  assert.equal(assistant, '结论：需要补货。');
  // reasoning 事件必须早于 assistant 事件
  const firstReasoningIndex = events.findIndex((e) => e.type === 'reasoning_delta');
  const firstAssistantIndex = events.findIndex((e) => e.type === 'assistant_delta');
  assert.ok(firstReasoningIndex < firstAssistantIndex);
});

test('外部 signal 取消：发 error 事件并正常 done，不抛未捕获异常', async () => {
  const slowTool = {
    name: 'test.slow',
    description: '测试用慢工具',
    provenance: 'assumption',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      await sleep(60);
      return { ok: true };
    },
  };
  const h = createHarness({
    extraTools: [slowTool],
    limits: { toolTimeoutMs: 1000 },
    script: () => ({ tool_calls: [{ name: 'test.slow', args: {} }] }),
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const { events, result } = await runTurn(h.runtime, {
    sessionId: 'sess_abort',
    message: '开始',
    signal: controller.signal,
  });
  assert.equal(result.finish_reason, 'aborted');
  assert.equal(events.at(-1).type, 'done');
  const error = eventsOfType(events, 'error')[0];
  assert.ok(error);
  assert.match(error.message, /取消/);
});
