/**
 * approval.mjs — 人工审批闸门（构造 / 校验 / 投影）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 *
 * 设计：
 *  - 审批是**写操作的前置条件**，不是提示词里的建议：`order.commit` 在工具层直接校验，
 *    无有效审批就返回 APPROVAL_REQUIRED，永远不给模型「自己判断要不要审批」的机会；
 *  - 草稿与审批 1:1（contracts §3），审批 id 由数据层生成；
 *  - 风险等级是**策略常量**（金额/数量阈值），不是业务计算口径，集中在此便于审计。
 */

/** 审批类型（目前只有订单提交） */
export const APPROVAL_KIND = 'order_commit';
/** 高风险阈值：金额（元）或数量（件）任一超过即 high */
export const HIGH_RISK_AMOUNT = 50000;
export const HIGH_RISK_QTY = 1000;

/**
 * 根据草稿内容给出审批风险等级（策略常量，可在评审时调整）。
 * @param {{total_amount?:number, total_qty?:number}} draft
 * @returns {'medium'|'high'}
 */
export function riskForDraft(draft) {
  const amount = Number(draft?.total_amount ?? 0);
  const qty = Number(draft?.total_qty ?? 0);
  return amount >= HIGH_RISK_AMOUNT || qty >= HIGH_RISK_QTY ? 'high' : 'medium';
}

/** 草稿摘要（进审批卡给人看，必须可读且含关键数字） */
export function summaryForDraft(draft) {
  const id = draft?.draft_id ?? draft?.id ?? '未知草稿';
  const kindLabel = (draft?.kind ?? 'purchase') === 'apply' ? '调拨申请' : '采购单';
  const qty = Number(draft?.total_qty ?? 0);
  const amount = Number(draft?.total_amount ?? 0);
  const items = Array.isArray(draft?.items) ? draft.items.length : 0;
  return `${kindLabel} ${id}：${items} 个 SKU，合计 ${qty} 件，金额 ${amount} 元`;
}

/**
 * 对外投影（SSE approval 事件 / HTTP 接口共用）。
 * @param {object} approval 数据层 approval 记录
 * @param {object} [draft]
 */
export function publicApproval(approval, draft) {
  if (!approval) return null;
  const draftId = approval.draft_id ?? draft?.draft_id ?? draft?.id ?? null;
  return {
    id: approval.id ?? approval.approval_id,
    kind: approval.kind ?? APPROVAL_KIND,
    summary: approval.summary ?? (draft ? summaryForDraft(draft) : ''),
    risk: approval.risk ?? (draft ? riskForDraft(draft) : 'medium'),
    status: approval.status ?? 'pending',
    draft_id: draftId,
    ref: { draft_id: draftId },
    session_id: approval.session_id ?? null,
    requested_by: approval.requested_by ?? 'agent',
    created_at: approval.created_at ?? approval.ts ?? null,
  };
}

/**
 * 为草稿创建审批请求（草稿落库后立刻创建，前端才有审批卡可渲染）。
 * @param {{db: unknown, repository: any, sessionId: string, draft: object,
 *          requestedBy?: string, summary?: string, risk?: string}} input
 */
export async function createDraftApproval({ db, repository, sessionId, draft, requestedBy = 'agent', summary, risk }) {
  if (typeof repository.createApproval !== 'function') {
    const err = new Error('数据层缺少 createApproval，无法创建审批');
    err.code = 'INTERNAL';
    throw err;
  }
  const draftId = draft?.draft_id ?? draft?.id;
  const approval = await repository.createApproval(db, {
    session_id: sessionId,
    draft_id: draftId,
    kind: APPROVAL_KIND,
    summary: summary ?? summaryForDraft(draft),
    risk: risk ?? riskForDraft(draft),
    requested_by: requestedBy,
  });
  return publicApproval(approval, draft);
}

/**
 * 提交前的硬校验：审批必须存在、属于该草稿、状态为 approved。
 * 返回结构化结果，**不抛异常**（便于工具层原样转成 { ok:false, error }）。
 * @param {{db: unknown, repository: any, approvalId?: string, draftId?: string}} input
 * @returns {Promise<{ok:true, approval:object} | {ok:false, error:{code:string,message:string,hint?:string}}>}
 */
export async function validateApprovalForCommit({ db, repository, approvalId, draftId }) {
  if (!approvalId || !draftId) {
    return {
      ok: false,
      error: {
        code: 'APPROVAL_REQUIRED',
        message: '提交订单必须提供 draft_id 与 approval_id：写操作只能先生成草稿并等人工审批',
        hint: '先调用 order.create_draft 生成草稿与审批，待审批通过后再提交',
      },
    };
  }
  if (typeof repository.getApproval !== 'function') {
    return {
      ok: false,
      error: { code: 'APPROVAL_REQUIRED', message: '数据层无法读取审批，拒绝提交', hint: '请检查数据层实现' },
    };
  }
  const approval = await repository.getApproval(db, approvalId);
  if (!approval) {
    return {
      ok: false,
      error: { code: 'APPROVAL_REQUIRED', message: `审批不存在：${approvalId}`, hint: '请使用 order.create_draft 返回的 approval_id' },
    };
  }
  if (approval.draft_id !== draftId) {
    return {
      ok: false,
      error: {
        code: 'APPROVAL_REQUIRED',
        message: `审批 ${approvalId} 不属于草稿 ${draftId}，拒绝提交`,
        hint: '审批与草稿必须一一对应',
      },
    };
  }
  if (approval.status !== 'approved') {
    return {
      ok: false,
      error: {
        code: 'APPROVAL_REQUIRED',
        message: `审批 ${approvalId} 当前状态为 ${approval.status}，只有 approved 才能提交`,
        hint: '请先由人在审批卡上批准',
      },
    };
  }
  return { ok: true, approval };
}
