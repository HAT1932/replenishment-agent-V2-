/**
 * audit.mjs — 审计查询工具（只读）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：contracts §4 #11 `audit.search`
 * 说明：查询本身也会被记录一条审计（tool_call + tool_result），这是预期行为（可追溯）。
 */
import { clampInt } from './util.mjs';

export function createAuditTools() {
  return [
    {
      name: 'audit.search',
      provenance: 'documented',
      write: false,
      description:
        '检索 Agent 审计事件（只读）。可按 session_id 与 kind（tool_call|tool_result|schedule_run|approval|...）过滤，' +
        'limit 默认 50、最大 200。返回事件 id/ts/actor/kind/tool/ok/duration_ms/provenance。' +
        'payload 已由 runtime 截断（≤2KB），用于排查"谁在什么时候用什么参数做了什么"。',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '会话 id' },
          kind: { type: 'string', description: '事件类型过滤（tool_call/tool_result/schedule_run/approval）' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '返回条数上限，默认 50' },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { repository } = ctx.deps;
        const events = await repository.searchAudit(ctx.db, {
          session_id: args.session_id,
          kind: args.kind,
          limit: clampInt(args.limit, 1, 200, 50),
        });
        return {
          events: (events ?? []).map((e) => ({
            id: e.id,
            ts: e.ts,
            session_id: e.session_id ?? null,
            actor: e.actor,
            kind: e.kind,
            tool: e.tool ?? null,
            ok: e.ok ?? true,
            duration_ms: e.duration_ms ?? 0,
            provenance: e.provenance ?? null,
            payload: e.payload ?? null,
          })),
        };
      },
      meta(data) {
        return { provenance: 'documented', summary: `返回 ${data.events.length} 条审计` };
      },
    },
  ];
}
