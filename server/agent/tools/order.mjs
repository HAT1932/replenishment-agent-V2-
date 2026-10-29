/**
 * order.mjs — 草稿与提交工具（写操作，必须审批）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：contracts §4 #8 `order.create_draft`、#9 `order.commit`、#10 `order.list_drafts`
 *
 * 硬规则：
 *  - create_draft 只落**草稿**，同时生成 1:1 审批请求（approval_required 事件的来源）；
 *  - commit 必须先经 approval.validateApprovalForCommit 校验：审批存在、属于本草稿、状态 approved，
 *    否则直接返回 APPROVAL_REQUIRED —— 不交给模型判断；
 *  - 金额/数量由数据层落库时计算，本文件不做业务计算。
 */
import { toolError } from './util.mjs';
import { createDraftApproval, validateApprovalForCommit } from '../approval.mjs';

const KINDS = ['purchase', 'apply'];

function normalizeItems(items, repository, db) {
  if (!Array.isArray(items) || items.length === 0) {
    toolError('VALIDATION_ERROR', 'items 不能为空');
  }
  return items.map((item, index) => {
    if (!item || typeof item !== 'object') toolError('VALIDATION_ERROR', `items[${index}] 必须是对象`);
    const skuCode = item.sku_code;
    if (!skuCode || typeof skuCode !== 'string') {
      toolError('VALIDATION_ERROR', `items[${index}].sku_code 必填`);
    }
    const num = Number(item.apply_num);
    if (!Number.isInteger(num) || num <= 0) {
      toolError('VALIDATION_ERROR', `items[${index}].apply_num 必须是正整数（件），收到 ${JSON.stringify(item.apply_num)}`);
    }
    return { sku_code: skuCode, apply_num: num };
  });
}

export function createOrderTools() {
  return [
    {
      name: 'order.create_draft',
      provenance: 'assumption',
      write: true,
      description:
        '生成补货草稿（写操作，**只生成草稿，需人工审批后提交**）。入参 kind=purchase(采购)/apply(调拨申请)，' +
        'items 为 [{sku_code, apply_num}]，apply_num 必须是正整数件；expected_arrival 为预计到货日 YYYY-MM-DD，remark 为备注。' +
        '返回 draft_id、明细、total_qty（件）、total_amount（元）、status="draft" 与 approval（审批请求）。' +
        '本工具不会生成正式单，也不会调用 order.commit。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS, description: 'purchase=采购单，apply=调拨申请' },
          items: {
            type: 'array',
            items: { type: 'object' },
            description: '草稿明细：[{sku_code, apply_num}]，apply_num 为正整数件',
          },
          expected_arrival: { type: 'string', description: '预计到货日 YYYY-MM-DD' },
          remark: { type: 'string', description: '备注' },
        },
        required: ['kind', 'items'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { repository } = ctx.deps;
        if (!KINDS.includes(args.kind)) toolError('VALIDATION_ERROR', `kind 必须是 ${KINDS.join('|')}`);
        const items = normalizeItems(args.items, repository, ctx.db);
        // 校验 SKU 存在（避免把错码写进草稿）
        for (const item of items) {
          const sku = await repository.getSkuByCode(ctx.db, item.sku_code);
          if (!sku) toolError('NOT_FOUND', `SKU 不存在：${item.sku_code}`);
        }
        const draft = await repository.createOrderDraft(ctx.db, {
          kind: args.kind,
          items,
          expected_arrival: args.expected_arrival ?? null,
          remark: args.remark ?? '',
          session_id: ctx.sessionId ?? null,
          created_by: 'agent',
        });
        if (!draft) toolError('INTERNAL', '数据层未返回草稿');
        const approval = await createDraftApproval({
          db: ctx.db,
          repository,
          sessionId: ctx.sessionId ?? null,
          draft,
          requestedBy: 'agent',
        });
        return {
          draft_id: draft.draft_id ?? draft.id,
          kind: draft.kind ?? args.kind,
          items: draft.items ?? items,
          total_qty: draft.total_qty ?? null,
          total_amount: draft.total_amount ?? null,
          status: draft.status ?? 'draft',
          expected_arrival: draft.expected_arrival ?? args.expected_arrival ?? null,
          approval,
        };
      },
      meta(data) {
        return {
          provenance: 'assumption',
          assumptions: [],
          summary: `已生成草稿 ${data.draft_id}（${data.total_qty} 件 / ${data.total_amount} 元），等待人工审批`,
          artifacts: [
            {
              kind: 'draft',
              title: `补货草稿 · ${data.draft_id}`,
              ref: {
                draft_id: data.draft_id,
                kind: data.kind,
                total_qty: data.total_qty,
                total_amount: data.total_amount,
                status: data.status,
              },
            },
          ],
          // runtime 据此发 approval_required 事件
          approval: data.approval,
        };
      },
    },
    {
      name: 'order.commit',
      provenance: 'assumption',
      write: true,
      description:
        '提交草稿为正式单（写操作，**必须携带有效 approval_id**）。前置条件：approval 必须存在、属于该 draft、' +
        '状态为 approved；否则工具直接返回 APPROVAL_REQUIRED，不会提交。返回 order_id、biz_no、status="committed"。' +
        '单位：件/元。',
      parameters: {
        type: 'object',
        properties: {
          draft_id: { type: 'string', description: '草稿 id' },
          approval_id: { type: 'string', description: '人工审批 id（状态必须为 approved）' },
        },
        required: ['draft_id', 'approval_id'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { repository } = ctx.deps;
        const gate = await validateApprovalForCommit({
          db: ctx.db,
          repository,
          approvalId: args.approval_id,
          draftId: args.draft_id,
        });
        if (!gate.ok) {
          // 直接失败，绝不"先试试看"
          toolError(gate.error.code, gate.error.message, { hint: gate.error.hint });
        }
        const order = await repository.commitDraft(ctx.db, args.draft_id, {
          approval_id: args.approval_id,
          operator: 'agent',
        });
        if (!order) toolError('INTERNAL', '数据层未返回正式单');
        return {
          order_id: order.order_id ?? order.id,
          kind: order.kind ?? null,
          biz_no: order.biz_no ?? null,
          status: order.status ?? 'committed',
          draft_id: args.draft_id,
          approval_id: args.approval_id,
        };
      },
      meta(data) {
        return {
          provenance: 'assumption',
          assumptions: [],
          summary: `已提交正式单 ${data.biz_no ?? data.order_id}（审批 ${data.approval_id}）`,
          artifacts: [
            {
              kind: 'draft',
              title: `正式单 · ${data.biz_no ?? data.order_id}`,
              ref: { order_id: data.order_id, biz_no: data.biz_no, status: data.status },
            },
          ],
        };
      },
    },
    {
      name: 'order.list_drafts',
      provenance: 'documented',
      write: false,
      description:
        '列出补货草稿（只读，不含正式单）。可选 status=draft|committed|rejected 过滤；默认全部。' +
        '返回草稿 id、类型、明细条数、合计数量（件）、合计金额（元）与状态。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['draft', 'committed', 'rejected'], description: '状态过滤' },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { repository } = ctx.deps;
        const drafts = await repository.listDrafts(ctx.db, { status: args.status });
        return {
          drafts: (drafts ?? []).map((d) => ({
            draft_id: d.draft_id ?? d.id,
            kind: d.kind ?? null,
            status: d.status ?? null,
            item_count: Array.isArray(d.items) ? d.items.length : 0,
            total_qty: d.total_qty ?? null,
            total_amount: d.total_amount ?? null,
            expected_arrival: d.expected_arrival ?? null,
            created_at: d.created_at ?? d.ts ?? null,
          })),
        };
      },
      meta(data) {
        return { provenance: 'documented', summary: `返回 ${data.drafts.length} 张草稿` };
      },
    },
  ];
}
