/**
 * router.tsx — 极简 hash 路由（零依赖）
 *
 * 契约 §7 路由表：
 *   #/agent(默认) #/sessions #/suggestions #/plans #/orders #/drafts #/audit #/schedules #/assumptions
 * 额外： #/plans/new（新建）、#/plans/:plan_id（编辑）
 * 查询串约定： #/agent?s=<session_id>、#/orders?kind=purchase|apply、#/audit?kind=&session=
 */
import { useEffect, useState } from 'react';

export type RouteName =
  | 'agent'
  | 'sessions'
  | 'suggestions'
  | 'plans'
  | 'plan-new'
  | 'plan-edit'
  | 'orders'
  | 'drafts'
  | 'audit'
  | 'schedules'
  | 'assumptions'
  | 'not-found';

export interface Route {
  name: RouteName;
  /** 路径参数（如 plan_id） */
  param: string | null;
  query: URLSearchParams;
  /** 原始 hash，用于调试 */
  raw: string;
}

const ROUTE_EVENT = 'ra:route';

const SIMPLE_ROUTES: Record<string, RouteName> = {
  agent: 'agent',
  sessions: 'sessions',
  suggestions: 'suggestions',
  plans: 'plans',
  orders: 'orders',
  drafts: 'drafts',
  audit: 'audit',
  schedules: 'schedules',
  assumptions: 'assumptions',
};

export function parseRoute(hash: string): Route {
  let raw = hash || '';
  if (raw.startsWith('#')) raw = raw.slice(1);
  if (raw === '' || raw === '/') raw = '/agent';

  const qIndex = raw.indexOf('?');
  const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const search = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
  const query = new URLSearchParams(search);

  const segments = path.split('/').filter((seg) => seg !== '');
  const head = segments[0] ?? 'agent';

  if (head === 'plans') {
    if (segments[1] === 'new') return { name: 'plan-new', param: null, query, raw };
    if (segments[1]) return { name: 'plan-edit', param: decodeURIComponent(segments[1]), query, raw };
    return { name: 'plans', param: null, query, raw };
  }

  const name = SIMPLE_ROUTES[head];
  if (name) return { name, param: segments[1] ? decodeURIComponent(segments[1]) : null, query, raw };

  return { name: 'not-found', param: head, query, raw };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', sync);
    window.addEventListener(ROUTE_EVENT, sync);
    // 首次进入时规范化为显式 hash，便于复制链接
    if (!window.location.hash) {
      window.history.replaceState(null, '', '#/agent');
    }
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener(ROUTE_EVENT, sync);
    };
  }, []);

  return route;
}

/** 跳转（默认 push，可 replace） */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const target = to.startsWith('#') ? to : `#${to.startsWith('/') ? '' : '/'}${to}`;
  if (options.replace) {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new Event(ROUTE_EVENT));
    return;
  }
  if (window.location.hash === target) {
    window.dispatchEvent(new Event(ROUTE_EVENT));
    return;
  }
  window.location.hash = target;
}

/** 更新当前路由的查询串（不新增历史记录，用于 agent?s=xxx 同步） */
export function replaceQuery(patch: Record<string, string | null>): void {
  const current = parseRoute(window.location.hash);
  const params = new URLSearchParams(current.query);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  const base = current.raw.startsWith('#') ? current.raw.slice(1) : current.raw;
  const pathPart = base.split('?')[0] ?? '/agent';
  const target = `#${pathPart}${qs ? `?${qs}` : ''}`;
  window.history.replaceState(null, '', target);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

export interface NavItem {
  path: string;
  label: string;
  icon: NavIconName;
  /** 该路由族匹配的路由名 */
  matches: RouteName[];
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export type NavIconName =
  | 'chat'
  | 'history'
  | 'table'
  | 'plan'
  | 'draft'
  | 'order'
  | 'shield'
  | 'clock'
  | 'book';

export const NAV_GROUPS: NavGroup[] = [
  {
    title: '工作台',
    items: [
      { path: '/agent', label: '智能助手', icon: 'chat', matches: ['agent'] },
      { path: '/sessions', label: '历史会话', icon: 'history', matches: ['sessions'] },
    ],
  },
  {
    title: '补货',
    items: [
      { path: '/suggestions', label: '补货建议', icon: 'table', matches: ['suggestions'] },
      { path: '/plans', label: '补货方案', icon: 'plan', matches: ['plans', 'plan-new', 'plan-edit'] },
      { path: '/drafts', label: '草稿单', icon: 'draft', matches: ['drafts'] },
      { path: '/orders', label: '正式单', icon: 'order', matches: ['orders'] },
    ],
  },
  {
    title: '治理',
    items: [
      { path: '/audit', label: '审计日志', icon: 'shield', matches: ['audit'] },
      { path: '/schedules', label: '定时任务', icon: 'clock', matches: ['schedules'] },
      { path: '/assumptions', label: '假设登记', icon: 'book', matches: ['assumptions'] },
    ],
  },
];

export const ROUTE_TITLES: Record<RouteName, string> = {
  agent: '智能补货助手',
  sessions: '历史会话',
  suggestions: '补货建议',
  plans: '补货方案',
  'plan-new': '新建方案',
  'plan-edit': '编辑方案',
  orders: '正式单',
  drafts: '草稿单',
  audit: '审计日志',
  schedules: '定时任务',
  assumptions: '假设登记 H1–H8',
  'not-found': '页面不存在',
};
