/**
 * schedule.mjs — 定时任务工具（只读列表 + 手动触发产草稿）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：contracts §4 #12 `schedule.list`、#13 `schedule.trigger`
 *
 * 说明：`schedule.trigger` 复用 scheduler.runScheduleOnce（同一套巡店逻辑），
 * 只生成草稿 + 审批 + 审计 + 通知（返回值里），**永不自动提交**。
 */
import { computeNextRun } from '../scheduler.mjs';
import { toolError } from './util.mjs';

export function createScheduleTools() {
  return [
    {
      name: 'schedule.list',
      provenance: 'documented',
      write: false,
      description:
        '列出定时补货任务（只读）。返回 id/name/cadence/plan_id/enabled/last_run_at/next_run_at；' +
        'next_run_at 缺失时按 cadence 与当前时间推算（hourly | daily@HH:mm | every:30m）。' +
        '定时任务只生成待审草稿，不会自动提交。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        const { repository } = ctx.deps;
        const rows = (await repository.listSchedules(ctx.db)) ?? [];
        const now = new Date(ctx.clock());
        return {
          schedules: rows.map((s) => {
            const cadence = s.cadence ?? 'daily@09:00';
            let next = s.next_run_at ?? s.nextAt ?? null;
            if (!next) {
              try {
                next = computeNextRun(cadence, now);
              } catch {
                next = null;
              }
            }
            return {
              id: s.id ?? s.schedule_id ?? null,
              name: s.name ?? s.schedule_name ?? null,
              cadence,
              plan_id: s.plan_id ?? null,
              store_id: s.store_id ?? null,
              enabled: s.enabled !== false,
              last_run_at: s.last_run_at ?? null,
              next_run_at: next,
            };
          }),
        };
      },
      meta(data) {
        return { provenance: 'documented', summary: `返回 ${data.schedules.length} 个定时任务` };
      },
    },
    {
      name: 'schedule.trigger',
      provenance: 'assumption',
      write: true,
      description:
        '手动触发一次「巡店补货」（写操作，**只生成草稿 + 审批请求，需人工审批后提交**）。' +
        '流程：suggestion.compute → 过滤过期/无建议 SKU → order.create_draft → 写审计 → 返回通知。' +
        '返回 run_id、draft_ids、approval_ids、summary、notifications；绝不自动 commit。',
      parameters: {
        type: 'object',
        properties: {
          schedule_id: { type: 'string', description: '定时任务 id（来自 schedule.list）' },
        },
        required: ['schedule_id'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { repository, domain } = ctx.deps;
        const rows = (await repository.listSchedules(ctx.db)) ?? [];
        const schedule = rows.find((s) => (s.id ?? s.schedule_id) === args.schedule_id);
        if (!schedule) toolError('NOT_FOUND', `定时任务不存在：${args.schedule_id}`);
        const { runScheduleOnce } = await import('../scheduler.mjs');
        const result = await runScheduleOnce({
          db: ctx.db,
          tools: ctx.registry,
          repository,
          domain,
          schedule,
          now: new Date(ctx.clock()),
        });
        return result;
      },
      meta(data) {
        return {
          provenance: 'assumption',
          assumptions: ['H1', 'H4'],
          as_of: data.as_of ?? null,
          summary: data.summary,
          artifacts: (data.draft_ids ?? []).map((draftId) => ({
            kind: 'draft',
            title: `定时草稿 · ${draftId}`,
            ref: { draft_id: draftId, run_id: data.run_id },
          })),
        };
      },
    },
  ];
}
