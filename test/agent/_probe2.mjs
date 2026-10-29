/**
 * _probe2.mjs — 临时联调探针 2：artifact / 审计 / 调度器（跑完删除）
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
import { runDueSchedules, triggerSchedule } from '../../server/agent/scheduler.mjs';

const dbPath = path.join(os.tmpdir(), `agent-probe2-${Date.now()}.db`);
const db = openDb(dbPath);
const clock = () => Date.now();
const tools = createToolRegistry({ db, domain, repository, queries, clock, limits: {} });
const provider = createProvider({ llm: { provider: 'mock' } });
const runtime = createRuntime({ db, provider, tools, clock, limits: {}, repository, domain });

const session = repository.createSession(db, { title: 'probe2' });
const sessionId = session.session_id ?? session.id;
await runtime.run({ sessionId, userMessage: '帮我看看哪些 SKU 需要补货，并生成采购草稿', onEvent: () => {} });
console.log('artifacts=', JSON.stringify(repository.listArtifacts(db, sessionId).map((a) => ({ id: a.id, kind: a.kind, title: a.title, content: a.content }))));
const audits = repository.searchAudit(db, { kind: 'tool_call', limit: 10 });
console.log('audit_sample=', JSON.stringify(audits.slice(0, 2)));
const draftAudit = repository.searchAudit(db, { kind: 'tool_result', limit: 20 }).find((a) => a.tool === 'order.create_draft');
console.log('draft_audit=', JSON.stringify(draftAudit));

console.log('schedules=', JSON.stringify(repository.listSchedules(db)));
const now = new Date().toISOString();
const due = await runDueSchedules({ db, runtime, now });
console.log('due=', JSON.stringify(due, null, 1).slice(0, 900));
console.log('runs=', JSON.stringify(repository.listRuns(db, { limit: 5 }).map((r) => ({ id: r.id, schedule_id: r.schedule_id, ok: r.ok, drafts: r.draft_ids }))));
const sch = repository.listSchedules(db)[0];
if (sch) {
  const forced = await triggerSchedule({ db, runtime, scheduleId: sch.id, now });
  console.log('trigger=', forced.run_id, JSON.stringify(forced.draft_ids), JSON.stringify(forced.notifications));
}
console.log('orders=', repository.listOrders(db).length, 'drafts=', repository.listDrafts(db).length, 'approvals=', repository.listApprovals(db, {}).length);
