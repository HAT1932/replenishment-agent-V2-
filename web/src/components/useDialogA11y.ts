/**
 * useDialogA11y.ts — Modal / Drawer 共用的无障碍行为
 *
 * 三件事（契约 §7 / 任务硬性纪律）：
 *  1) focus trap：Tab / Shift+Tab 在对话框内循环，不跑到背景页面；
 *  2) Esc 关闭；
 *  3) 还焦：关闭后把焦点还给打开它的元素。
 * 额外：打开期间锁定 body 滚动，避免背景跟着滚。
 */
import { useEffect } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return nodes.filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // offsetParent 为 null 通常表示 display:none（position:fixed 元素除外）
    return el.offsetParent !== null || el === document.activeElement;
  });
}

export function useDialogA11y(
  open: boolean,
  onClose: () => void,
  containerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // 等一帧再聚焦，确保内容已挂载
    const focusTimer = window.setTimeout(() => {
      const root = containerRef.current;
      const first = focusableIn(root)[0];
      if (first) first.focus();
      else root?.focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const root = containerRef.current;
      const list = focusableIn(root);
      if (list.length === 0) {
        event.preventDefault();
        root?.focus();
        return;
      }

      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;

      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && (active === first || active === root || !root?.contains(active))) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open, onClose, containerRef]);
}
