/**
 * Drawer.tsx — 右侧抽屉（portal + focus trap + Esc + 还焦）
 * 用于 SKU 解释下钻、草稿明细、工具原始结果等「不离开当前页」的深度查看。
 */
import { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDialogA11y } from './useDialogA11y';

export interface DrawerProps {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  /** 宽版抽屉（760px），解释类内容用 */
  wide?: boolean;
}

export function Drawer({ open, title, subtitle, children, footer, onClose, wide = false }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useDialogA11y(open, onClose, panelRef);

  if (!open) return null;

  return createPortal(
    <div
      className="ra-drawer-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`ra-drawer${wide ? ' ra-drawer-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="ra-drawer-head">
          <div className="ra-grow">
            <div className="ra-drawer-title" id={titleId}>
              {title}
            </div>
            {subtitle ? <div className="ra-drawer-sub">{subtitle}</div> : null}
          </div>
          <button type="button" className="ra-close" onClick={onClose} aria-label="关闭抽屉">
            ×
          </button>
        </div>
        <div className="ra-drawer-body">{children}</div>
        {footer ? <div className="ra-drawer-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
