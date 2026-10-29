/**
 * assumption.mjs — 假设清单工具（只读）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：contracts §4 #14 `assumption.list`
 * 数据来自 domain.ASSUMPTIONS（Lead 维护），本文件只做投影，不新增/修改假设。
 */
export function createAssumptionTools() {
  return [
    {
      name: 'assumption.list',
      provenance: 'documented',
      write: false,
      description:
        '列出本项目全部未证实假设（只读）。返回 id（H1–H10）、statement（假设陈述）、confidence（high|medium|low）、' +
        'evidence（证据强度）、risk（翻盘影响）、probe（验证方式）。回答中引用任何假设时，必须用这里的原文 id 与陈述。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        const { domain } = ctx.deps;
        const list = domain.ASSUMPTIONS ?? domain.listAssumptions?.() ?? [];
        return { assumptions: list };
      },
      meta(data) {
        return {
          provenance: 'documented',
          assumptions: data.assumptions.map((a) => a.id),
          summary: `返回 ${data.assumptions.length} 条假设`,
        };
      },
    },
  ];
}
