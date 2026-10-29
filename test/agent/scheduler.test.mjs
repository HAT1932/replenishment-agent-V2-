/**
 * scheduler.test.mjs — Auto 入口：cadence 计算 + 到期扫描 + 只产草稿（永不提交）
 * 自测：node --test test/agent
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/fixtures.mjs';
import {
  computeNextRun,
  parseCadence,
  runDueSchedules,
  runScheduleOnce,
  triggerSchedule,
} from '../../server/agent/scheduler.mjs';

test('computeNextRun：hourly / daily@HH:mm / every:Nm 三种 cadence', () => {
  assert.equal(computeNextRun('hourly', '2026-10-29T01:20:00.000Z'), '2026-10-29T02:00:00.000Z');
  assert.equal(computeNextRun('hourly', '2026-10-29T02:00:00.000Z'), '2026-10-29T03:00:00.000Z');

  // daily@09:00 默认按 UTC+8 解释
  assert.equal(computeNextRun('daily@09:00', '2026-10-29T02:00:00.000Z'), '2026-10-30T01:00:00.000Z');
  assert.equal(computeNextRun('daily@09:00', '2026-10-29T00:00:00.000Z'), '2026-10-29T01:00:00.000Z');
  // 时区可覆盖
  assert.equal(
    computeNextRun('daily@09:00', '2026-10-29T02:00:00.000Z', { tzOffsetMinutes: 0 }),
    '2026-10-29T09:00:00.000Z',
  );

  assert.equal(computeNextRun('every:30m', '2026-10-29T02:00:00.000Z'), '2026-10-29T02:30:00.000Z');
  assert.equal(computeNextRun('every:2h', '2026-10-29T02:00:00.000Z'), '2026-10-29T04:00:00.000Z');
  assert.equal(computeNextRun('every:1d', '2026-10-29T02:00:00.000Z'), '2026-10-30T02:00:00.000Z');
});

test('parseCadence 严格校验：非法 cadence 明确报错', () => {
  assert.deepEqual(parseCadence('hourly'), { kind: 'hourly', raw: 'hourly' });
  assert.equal(parseCadence('daily@23:59').kind, 'daily');
  assert.equal(parseCadence('every:45m').intervalMs, 45 * 60_000);
  for (const bad of ['', 'weekly', 'daily@25:00', 'every:0m', 'every:30x', 'daily']) {
    assert.throws(() => parseCadence(bad), (err) => err.code === 'VALIDATION_ERROR', `应拒绝 ${bad}`);
  }
});

test('runDueSchedules：到期任务生成草稿 + 审批 + 审计 + 通知，永不自动提交', async () => {
  const h = createHarness();
  const now = '2026-10-29T02:00:00.000Z';
  const { runs, checked } = await runDueSchedules({
    db: h.db,
    tools: h.tools,
    repository: h.repository,
    now,
  });

  assert.equal(checked, 1);
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.schedule_id, 'sch_1');
  assert.equal(run.ok, true);
  assert.equal(run.draft_ids.length, 1);
  assert.equal(run.approval_ids.length, 1);
  assert.equal(run.notifications.length, 1);
  assert.match(run.summary, /等待人工审批/);
  assert.ok(run.next_run_at, '必须推进 next_run_at');
  assert.equal(run.next_run_at, '2026-10-30T01:00:00.000Z'); // 次日 09:00 +08

  // 过期 SKU 不进自动草稿（SP002 snapshot 8 天前）
  assert.ok(run.skipped.some((s) => s.sku_code === 'SP002' && s.reason === 'stale_data'));
  const draft = h.repository.state.drafts[0];
  assert.equal(draft.items.length, 1);
  assert.equal(draft.items[0].sku_code, 'SP001');

  // 硬规则：Auto 入口永不提交
  assert.equal(h.repository.state.orders.length, 0);
  assert.equal(h.repository.state.approvals.length, 1);
  assert.equal(h.repository.state.approvals[0].status, 'pending');

  // 审计：工具级（actor=scheduler）+ 任务级 schedule_run
  assert.ok(h.repository.state.audits.some((a) => a.kind === 'schedule_run' && a.actor === 'scheduler'));
  assert.ok(h.repository.state.audits.some((a) => a.kind === 'tool_call' && a.actor === 'scheduler'));
  assert.ok(h.repository.state.scheduleRuns.length === 1);
  assert.equal(h.repository.state.schedules[0].next_run_at, '2026-10-30T01:00:00.000Z');
});

test('runDueSchedules：未到期不执行；无 next_run_at 只计算下次时间', async () => {
  const future = createHarness({
    seed: {
      schedules: [
        { id: 'sch_future', name: '未来任务', cadence: 'daily@09:00', enabled: true, next_run_at: '2026-10-30T01:00:00.000Z' },
      ],
    },
  });
  const futureRes = await runDueSchedules({ db: future.db, tools: future.tools, repository: future.repository, now: '2026-10-29T02:00:00.000Z' });
  assert.equal(futureRes.runs.length, 0);
  assert.equal(future.repository.state.drafts.length, 0);

  const fresh = createHarness({
    seed: {
      schedules: [{ id: 'sch_new', name: '新任务', cadence: 'every:30m', enabled: true, next_run_at: null }],
    },
  });
  const freshRes = await runDueSchedules({ db: fresh.db, tools: fresh.tools, repository: fresh.repository, now: '2026-10-29T02:00:00.000Z' });
  assert.equal(freshRes.runs.length, 1);
  assert.equal(freshRes.runs[0].skipped_reason, 'no_next_run_at');
  assert.equal(freshRes.runs[0].next_run_at, '2026-10-29T02:30:00.000Z');
  assert.equal(fresh.repository.state.drafts.length, 0, '首次调度不得偷偷生成全量草稿');
});

test('runDueSchedules：禁用任务跳过', async () => {
  const h = createHarness({
    seed: {
      schedules: [
        { id: 'sch_off', name: '停用任务', cadence: 'hourly', enabled: false, next_run_at: '2026-10-29T00:00:00.000Z' },
      ],
    },
  });
  const res = await runDueSchedules({ db: h.db, tools: h.tools, repository: h.repository, now: '2026-10-29T02:00:00.000Z' });
  assert.equal(res.runs.length, 0);
});

test('runScheduleOnce：重复运行仍只产草稿，且每次都有通知与审计', async () => {
  const h = createHarness();
  const schedule = (await h.repository.listSchedules())[0];
  const first = await runScheduleOnce({
    db: h.db,
    tools: h.tools,
    repository: h.repository,
    domain: h.domain,
    schedule,
    now: '2026-10-29T02:00:00.000Z',
  });
  const second = await runScheduleOnce({
    db: h.db,
    tools: h.tools,
    repository: h.repository,
    domain: h.domain,
    schedule,
    now: '2026-10-29T03:00:00.000Z',
  });
  assert.notEqual(first.run_id, second.run_id);
  assert.equal(h.repository.state.drafts.length, 2);
  assert.equal(h.repository.state.approvals.length, 2);
  assert.equal(h.repository.state.orders.length, 0, '任何情况下都不自动提交');
  assert.equal(h.repository.state.audits.filter((a) => a.kind === 'schedule_run').length, 2);
});

test('手动触发：only+force 与 triggerSchedule 复用同一套逻辑（只产草稿）', async () => {
  const h = createHarness({
    seed: {
      schedules: [
        { id: 'sch_future', name: '未来任务', cadence: 'daily@09:00', enabled: true, next_run_at: '2026-11-01T01:00:00.000Z' },
      ],
    },
  });
  const now = '2026-10-29T02:00:00.000Z';

  // 未到期 + force：仍然执行
  const forced = await runDueSchedules({ db: h.db, runtime: h.runtime, now, only: ['sch_future'], force: true });
  assert.equal(forced.runs.length, 1);
  assert.equal(forced.runs[0].draft_ids.length, 1);
  assert.equal(forced.runs[0].notifications.length, 1);

  // triggerSchedule（HTTP 层优先用它）
  const run = await triggerSchedule({ db: h.db, runtime: h.runtime, scheduleId: 'sch_future', now });
  assert.equal(run.schedule_id, 'sch_future');
  assert.equal(run.draft_ids.length, 1);
  assert.equal(h.repository.state.orders.length, 0, '手动触发也绝不自动提交');

  await assert.rejects(
    () => triggerSchedule({ db: h.db, runtime: h.runtime, scheduleId: 'nope', now }),
    (err) => err.code === 'NOT_FOUND',
  );
});
