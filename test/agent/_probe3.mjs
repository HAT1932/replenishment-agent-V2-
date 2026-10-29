import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../server/data/db.mjs';
import * as repository from '../../server/data/repository.mjs';
import * as queries from '../../server/data/queries.mjs';
import * as domain from '../../server/domain/index.mjs';
import { createToolRegistry } from '../../server/agent/tools/index.mjs';
import { createRuntime } from '../../server/agent/runtime.mjs';
import { createProvider } from '../../server/providers/index.mjs';
import { triggerSchedule } from '../../server/agent/scheduler.mjs';

const db = openDb(path.join(os.tmpdir(), `agent-probe3-${Date.now()}.db`));
const clock = () => Date.now();
const tools = createToolRegistry({ db, domain, repository, queries, clock, limits: {} });
const provider = createProvider({ llm: { provider: 'mock' } });
const runtime = createRuntime({ db, provider, tools, clock, limits: {}, repository, domain });

const sch = repository.listSchedules(db)[0];
console.log('schedule=', JSON.stringify(sch));
const sugg = await tools.execute('suggestion.compute', { plan_id: sch.plan_id, as_of: '2026-10-29', only_low: true }, { actor: 'scheduler' });
console.log('sugg.ok=', sugg.ok, 'err=', JSON.stringify(sugg.error), 'rows=', sugg.data?.rows?.length, 'kpi=', JSON.stringify(sugg.data?.kpi));
const run = await triggerSchedule({ db, runtime, scheduleId: sch.id, now: '2026-10-29T02:00:00.000Z' });
console.log('run=', JSON.stringify({ ok: run.ok, error: run.error, summary: run.summary, draft_ids: run.draft_ids, skipped: run.skipped, next: run.next_run_at }));
console.log('runs=', JSON.stringify(repository.listRuns(db).map((r) => ({ id: r.id, ok: r.ok, drafts: r.draft_ids }))));
