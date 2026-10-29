/**
 * hooks.ts — 通用数据获取 / 交互小钩子
 *
 * 只做「状态与副作用」封装，不含任何业务计算。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { errorMessage } from './api';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** 手动重取（按钮 / 重试） */
  reload: () => void;
  /** 局部更新（例如审批后回填单条） */
  setData: (next: T | null) => void;
}

/**
 * 声明式取数：自动 abort 上一次请求，避免竞态与卸载后 setState。
 * `loader` 必须接受 AbortSignal；deps 变化即重取。
 */
export function useAsyncData<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean } = {},
): AsyncState<T> {
  const enabled = options.enabled !== false;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    setError(null);

    loaderRef
      .current(controller.signal)
      .then((result) => {
        if (!alive) return;
        setData(result);
      })
      .catch((e: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setError(errorMessage(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload, setData };
}

/** 输入防抖（筛选框用，避免每次击键都打 API） */
export function useDebounced<T>(value: T, delayMs = 320): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** 稳定引用的最新值（事件回调里读最新 state，不进依赖数组） */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** 集合型状态：勾选行 / 展开行 */
export function useSetState<T>(initial?: Iterable<T>) {
  const [set, setSet] = useState<Set<T>>(() => new Set<T>(initial ?? []));

  const toggle = useCallback((key: T) => {
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const addMany = useCallback((keys: Iterable<T>) => {
    setSet((prev) => {
      const next = new Set(prev);
      for (const key of keys) next.add(key);
      return next;
    });
  }, []);

  const removeMany = useCallback((keys: Iterable<T>) => {
    setSet((prev) => {
      const next = new Set(prev);
      for (const key of keys) next.delete(key);
      return next;
    });
  }, []);

  const replace = useCallback((keys: Iterable<T>) => setSet(new Set(keys)), []);
  const clear = useCallback(() => setSet(new Set<T>()), []);

  return useMemo(
    () => ({ set, toggle, addMany, removeMany, replace, clear }),
    [set, toggle, addMany, removeMany, replace, clear],
  );
}

/** 点击外部关闭（下拉/浮层） */
export function useClickOutside<T extends HTMLElement>(
  onOutside: () => void,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const handler = useLatest(onOutside);

  useEffect(() => {
    const listener = (event: MouseEvent | TouchEvent) => {
      const el = ref.current;
      if (!el) return;
      if (event.target instanceof Node && !el.contains(event.target)) handler.current();
    };
    document.addEventListener('mousedown', listener);
    document.addEventListener('touchstart', listener);
    return () => {
      document.removeEventListener('mousedown', listener);
      document.removeEventListener('touchstart', listener);
    };
  }, [handler]);

  return ref;
}

/** 把「滚动到底部」固定到流式消息上（用户上翻时不抢滚动） */
export function useStickyScrollToBottom<T extends HTMLElement>(dep: unknown): {
  ref: RefObject<T | null>;
  stick: boolean;
} {
  const ref = useRef<T | null>(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      setStick(atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !stick) return;
    el.scrollTop = el.scrollHeight;
  }, [dep, stick]);

  return { ref, stick };
}
