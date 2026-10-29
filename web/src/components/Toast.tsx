/**
 * Toast.tsx — 轻提示（aria-live="polite"，不抢焦点）
 * 用法：const toast = useToast(); toast('已保存'); toast('失败原因', 'err');
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type ToastKind = 'ok' | 'err' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export type PushToast = (message: string, kind?: ToastKind) => void;

const ToastContext = createContext<PushToast>(() => {
  /* 没有 Provider 时静默降级（SSR / 单测） */
});

export function useToast(): PushToast {
  return useContext(ToastContext);
}

const DURATION: Record<ToastKind, number> = { ok: 2600, info: 3200, err: 5200 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seqRef = useRef(0);
  const timersRef = useRef<number[]>([]);

  useEffect(
    () => () => {
      timersRef.current.forEach((t) => window.clearTimeout(t));
      timersRef.current = [];
    },
    [],
  );

  const push = useCallback<PushToast>((message, kind = 'ok') => {
    const id = ++seqRef.current;
    setItems((prev) => [...prev.slice(-3), { id, kind, message }]);
    const timer = window.setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id));
    }, DURATION[kind]);
    timersRef.current.push(timer);
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* 常驻 live region：读屏只在内容变化时播报 */}
      <div className="ra-toast-wrap" role="region" aria-live="polite" aria-label="操作通知">
        {items.map((item) => (
          <div key={item.id} className={`ra-toast ra-toast-${item.kind}`} role="status">
            <span className="ra-grow">{item.message}</span>
            <button
              type="button"
              className="ra-close"
              style={{ color: 'inherit', width: 18, height: 18, fontSize: 14 }}
              onClick={() => dismiss(item.id)}
              aria-label={`关闭通知：${item.message}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
