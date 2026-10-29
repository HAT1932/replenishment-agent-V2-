/**
 * Modal.tsx — 居中弹窗（portal + focus trap + Esc + 还焦）
 * 用于二次确认、审批选择、方案删除等打断式交互。
 */
import { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDialogA11y } from './useDialogA11y';

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  /** 对话框最大宽度（px），默认 460 */
  width?: number;
  /** 关闭时是否允许点遮罩关闭，默认 true */
  closeOnOverlay?: boolean;
  describedBy?: string;
}

export function Modal({
  open,
  title,
  children,
  footer,
  onClose,
  width = 460,
  closeOnOverlay = true,
  describedBy,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useDialogA11y(open, onClose, panelRef);

  if (!open) return null;

  return createPortal(
    <div
      className="ra-modal-overlay"
      onMouseDown={(event) => {
        if (!closeOnOverlay) return;
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="ra-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy ?? descId}
        ref={panelRef}
        tabIndex={-1}
        style={{ maxWidth: width }}
      >
        <div className="ra-modal-head">
          <div className="ra-modal-title" id={titleId}>
            {title}
          </div>
          <button type="button" className="ra-close" onClick={onClose} aria-label="关闭对话框">
            ×
          </button>
        </div>
        <div className="ra-modal-body" id={descId}>
          {children}
        </div>
        {footer ? <div className="ra-modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
