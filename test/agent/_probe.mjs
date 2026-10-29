/**
 * _probe.mjs — 临时联调探针（不入库，跑完删除）
 */
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../server/data/db.mjs';
import * as repository from '../../server/data/repository.mjs';
import * as queries from '../../server/data/queries.mjs';
import * as domain from '../../server/domain/index.mjs';
import { createToolRegistry } from '../../server/agent/tools/index.mjs';
import { createRuntime } from '../../server/agent/runtime.mjs';
import { createProvider } from '../../server/providers/index.mjs';

const dbPath = path.join(os.tmpdir(), `agent-probe-${Date.now()}.db`);
const db = openDb(dbPath);
const clock = () => Date.now();
const tools = createToolRegistry({ db, domain, repository, queries, clock, limits: {} });
const provider = createProvider({ llm: { provider: 'mock' } });
const runtime = createRuntime({ db, provider, tools, clock, limits: {}, repository, domain });

const meta = repository.getMeta(db);
console.log('today=', meta.today, 'counts=', meta.counts);

const session = repository.createSession(db, { title: 'probe' });
const sessionId = session.session_id ?? session.id;
const events = [];
const result = await runtime.run({ sessionId, userMessage: '帮我看看哪些 SKU 需要补货，并生成采购草稿', onEvent: (e) => events.push(e) });
console.log('finish=', result.finish_reason, 'steps=', result.steps, 'tools=', result.tool_calls);
console.log('types=', events.filter((e) => !/delta/.test(e.type)).map((e) => e.type).join(','));
console.log('toolNames=', events.filter((e) => e.type === 'tool_call').map((e) => e.name).join(','));
const suggestionResult = events.find((e) => e.type === 'tool_result' && e.name === 'suggestion.compute');
console.log('suggestion.ok=', suggestionResult?.ok, 'rows=', suggestionResult?.data?.rows?.length, 'kpi=', JSON.stringify(suggestionResult?.data?.kpi));
console.log('approval=', JSON.stringify(events.find((e) => e.type === 'approval_required')?.approval));
if (result.finish_reason !== 'stop') console.log('deltas=', events.filter((e) => /delta/.test(e.type)).map((e) => e.text).join(''));

const approval = events.find((e) => e.type === 'approval_required')?.approval;
if (approval) {
  repository.resolveApproval(db, approval.id, { decision: 'approve', operator: 'human' });
  const events2 = [];
  const result2 = await runtime.run({ sessionId, userMessage: '已批准，提交订单', onEvent: (e) => events2.push(e) });
  console.log('turn2 finish=', result2.finish_reason, 'tools=', events2.filter((e) => e.type === 'tool_call').map((e) => e.name).join(','));
  const commit = events2.find((e) => e.type === 'tool_result' && e.name === 'order.commit');
  console.log('commit.ok=', commit?.ok, 'error=', JSON.stringify(commit?.error), 'data=', JSON.stringify(commit?.data));
  console.log('orders=', JSON.stringify(repository.listOrders(db).map((o) => ({ id: o.id, biz_no: o.biz_no, status: o.status }))));
}
console.log('auditCount=', repository.searchAudit(db, { limit: 100 }).length);
