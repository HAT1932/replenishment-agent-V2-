/**
 * DraftCard.tsx — 草稿单卡片（#/drafts、会话产物、审批流共用）
 *
 * 关键护栏：**草稿不能直接变成正式单**，提交必须携带有效 approval_id（契约 §6）。
 * 因此这里的「提交」是二次确认弹窗 + 选择/填写审批单号，失败要把后端原因原样展示。
 */
import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { apiPost, errorCode, errorMessage } from '../../lib/api';
import { DASH, fmtDateTime, fmtInt, fmtMoney } from '../../lib/format';
import type { Approval, Draft, DraftItem, Order } from '../../app/types';

const KIND_LABEL: Record<string, string> = {
  purchase: '采购单',
  apply: '要货申请单',
};

function draftIdOf(draft: Draft): string {
  return draft.draft_id ?? draft.id ?? '';
}

function ItemsTable({ items }: { items: DraftItem[] }) {
  if (items.length === 0) {
    return <div className="ra-hint">该草稿没有明细行。</div>;
  }
  return (
    <div className="ra-items">
      <div className="ra-item-row ra-item-row-head">
        <span>商品</span>
        <span>单位</span>
        <span className="ra-num">建议数量</span>
        <span className="ra-num">采购数量</span>
        <span className="ra-num">小计</span>
      </div>
      {items.map((item, index) => (
        <div className="ra-item-row" key={`${item.sku_code ?? 'row'}-${index}`}>
          <span className="ra-truncate" title={item.product_name ?? item.sku_code}>
            {item.product_name ?? item.sku_code ?? DASH}
            <span className="ra-prod-meta" style={{ marginLeft: 6 }}>
              {item.sku_code ?? ''}
            </span>
          </span>
          <span className="ra-muted">{item.unit ?? DASH}</span>
          <span className="ra-num">{fmtInt(item.suggest_num)}</span>
          <span className="ra-num">{fmtInt(item.apply_num)}</span>
          <span className="ra-num">{fmtMoney(item.amount)}</span>
        </div>
      ))}
    </div>
  );
}

export interface DraftCardProps {
  draft: Draft;
  /** 该草稿相关的待审批单（用于下拉选择） */
  pendingApprovals?: Approval[];
  onCommitted?: (order: Order, draft: Draft) => void;
}

export function DraftCard({ draft, pendingApprovals = [], onCommitted }: DraftCardProps) {
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [approvalId, setApprovalId] = useState('');
  const [manualId, setManualId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const id = draftIdOf(draft);
  const items = draft.items ?? [];
  const committed = draft.order_id || (draft.status && draft.status !== 'draft');

  const candidates = pendingApprovals.filter(
    (approval) => !approval.draft_id || !id || approval.draft_id === id,
  );

  const submit = async () => {
    const chosen = manualId.trim() || approvalId;
    if (chosen === '') {
      setCommitError('请选择或填写审批单号：提交正式单必须携带有效 approval_id。');
      return;
    }
    setSubmitting(true);
    setCommitError(null);
    try {
      // 契约 §6：POST /api/drafts/:id/commit → { order }（幂等）
      const response = await apiPost<{ order?: Order } | Order>(
        `/drafts/${encodeURIComponent(id)}/commit`,
        { approval_id: chosen },
      );
      const order =
        response && typeof response === 'object' && 'order' in response
          ? (response as { order?: Order }).order
          : (response as Order);
      toast(`已提交：${order?.biz_no ?? order?.order_id ?? '（服务端未返回单号）'}`, 'ok');
      setConfirmOpen(false);
      setApprovalId('');
      setManualId('');
      if (order) onCommitted?.(order, draft);
    } catch (e: unknown) {
      const code = errorCode(e);
      const message =
        code === 'APPROVAL_REQUIRED'
          ? '服务端拒绝了提交：没有有效审批（APPROVAL_REQUIRED）。请先在会话中批准该草稿。'
          : `提交失败：${errorMessage(e)}`;
      setCommitError(message);
      toast(message, 'err');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ra-draft-card">
      <div className="ra-draft-head">
        <span className="ra-tag ra-tag-info">{KIND_LABEL[draft.kind ?? 'purchase'] ?? draft.kind}</span>
        <span className="ra-draft-id">草稿 {id || '（无 id）'}</span>
        <span className={`ra-tag ${committed ? 'ra-tag-ok' : 'ra-tag-warn'}`}>
          {committed ? `已提交${draft.order_id ? ` · ${draft.order_id}` : ''}` : draft.status ?? 'draft'}
        </span>
        <span className="ra-faint ra-xs">{fmtDateTime(draft.created_at)}</span>
        <span className="ra-right ra-row ra-gap-3">
          <span>
            数量 <b className="ra-num">{fmtInt(draft.total_qty)}</b>
          </span>
          <span>
            金额 <b className="ra-num">{fmtMoney(draft.total_amount)}</b>
          </span>
          {!committed ? (
            <button type="button" className="ra-btn ra-btn-primary ra-btn-sm" onClick={() => setConfirmOpen(true)}>
              提交（需审批）
            </button>
          ) : null}
        </span>
      </div>

      <div className="ra-draft-body">
        {draft.expected_arrival ? (
          <div className="ra-hint">预计到货：{draft.expected_arrival}</div>
        ) : null}
        {draft.remark ? <div className="ra-hint">备注：{draft.remark}</div> : null}
        {commitError && !confirmOpen ? (
          <div className="ra-alert ra-alert-danger" role="alert">
            {commitError}
          </div>
        ) : null}
        <ItemsTable items={items} />
      </div>

      <Modal
        open={confirmOpen}
        title="提交草稿为正式单"
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <button type="button" className="ra-btn" onClick={() => setConfirmOpen(false)} disabled={submitting}>
              取消
            </button>
            <button type="button" className="ra-btn ra-btn-primary" onClick={() => void submit()} disabled={submitting}>
              {submitting ? <span className="ra-spinner" aria-hidden="true" /> : null}
              确认提交
            </button>
          </>
        }
      >
        <div className="ra-col ra-gap-3">
          <div className="ra-alert ra-alert-warn">
            提交是不可逆的写操作，必须携带有效审批单号。服务端在缺少审批时会直接拒绝（APPROVAL_REQUIRED），
            不由模型判断。
          </div>

          <label className="ra-field-block">
            <span>选择待审批单</span>
            <select
              className="ra-select"
              value={approvalId}
              onChange={(event) => setApprovalId(event.target.value)}
              disabled={candidates.length === 0}
            >
              <option value="">
                {candidates.length === 0 ? '（没有待审批记录）' : '请选择…'}
              </option>
              {candidates.map((approval) => (
                <option key={approval.id} value={approval.id}>
                  {approval.id} · {approval.summary ? approval.summary.slice(0, 40) : '审批单'}
                </option>
              ))}
            </select>
          </label>

          <label className="ra-field-block">
            <span>或手动填写审批单号</span>
            <input
              className="ra-input"
              value={manualId}
              onChange={(event) => setManualId(event.target.value)}
              placeholder="apv_xxx"
            />
          </label>

          <div className="ra-hint">
            草稿 {id} · 数量 {fmtInt(draft.total_qty)} · 金额 {fmtMoney(draft.total_amount)}
          </div>

          {commitError ? (
            <div className="ra-alert ra-alert-danger" role="alert">
              {commitError}
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
