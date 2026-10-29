/**
 * App.tsx — 应用外壳（契约 §7）
 * ---------------------------------------------------------------------------
 * 结构：左侧导航（3 组 9 项）+ 顶栏（标题/口径说明 + 数据日期·模型·规模）+ 主内容区。
 * 纪律：
 *  - 后端不可达时**不白屏**：整页 ErrorState + 重试 + 排查清单（DoD 要求）；
 *  - 页面只做布局与路由，业务数据由各 feature 页自己取（/api/*），KPI 一律服务端算；
 *  - 类名对齐既有 `features.css`（.ra-topbar-chip / .ra-status / .ra-nav-item[aria-current]）。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { NAV_GROUPS, ROUTE_TITLES, navigate, useRoute, type NavIconName, type RouteName } from './router';
import { apiGet } from '../lib/api';
import { useAsyncData } from '../lib/hooks';
import { ErrorState, EmptyState } from '../components/States';
import { AgentPage } from '../features/agent/AgentPage';
import { SessionsPage } from '../features/agent/SessionsPage';
import { SuggestionsPage } from '../features/suggestion/SuggestionsPage';
import { WorkbenchPage } from '../features/workbench/WorkbenchPage';
import { SkuDetailPage } from '../features/sku/SkuDetailPage';
import { PlansPage } from '../features/plan/PlansPage';
import { PlanEditorPage } from '../features/plan/PlanEditorPage';
import { DraftsPage } from '../features/order/DraftsPage';
import { OrdersPage } from '../features/order/OrdersPage';
import { AuditPage } from '../features/audit/AuditPage';
import { SchedulesPage } from '../features/schedule/SchedulesPage';
import { AssumptionsPage } from '../features/assumption/AssumptionsPage';
import { fmtInt } from '../lib/format';
import type { HealthInfo, MetaInfo } from './types';

/* ------------------------------- 图标 ---------------------------------- */

const ICON_PATHS: Record<NavIconName, string> = {
  chat: 'M3 4.5h14v9H8.5L4.5 17v-3.5H3v-9Z',
  history: 'M10 3.5a6.5 6.5 0 1 1-6.2 4.5M3.5 3v4h4M10 7v3.5l2.5 1.5',
  table: 'M3 4.5h14v11H3v-11Zm0 4h14M8 8.5v7',
  plan: 'M4 3.5h9l3 3v10H4v-13Zm2.5 5.5h7M6.5 12h5',
  draft: 'M4 3.5h8.5L16 7v9.5H4v-13Zm8.5 0V7H16M6.5 10h7M6.5 13h4.5',
  order: 'M4 3.5h12v13H4v-13Zm2.5 4h7M6.5 10.5h7M6.5 13h4',
  shield: 'M10 2.8 16 5v5.2c0 3.4-2.4 5.6-6 7-3.6-1.4-6-3.6-6-7V5l6-2.2Zm-2.2 7.4 1.8 1.8 3.4-3.6',
  clock: 'M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM10 6.5V10l2.5 1.8',
  book: 'M4 4h5.5c.8 0 1.5.7 1.5 1.5V17c0-.8-.7-1.5-1.5-1.5H4V4Zm12 0h-5.5c-.8 0-1.5.7-1.5 1.5V17c0-.8.7-1.5 1.5-1.5H16V4Z',
};

function NavIcon({ name }: { name: NavIconName }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/* ------------------------------- 页面 ---------------------------------- */

function renderPage(route: ReturnType<typeof useRoute>, health: HealthInfo | null) {
  switch (route.name) {
    case 'agent':
      return <AgentPage initialSessionId={route.query.get('s')} health={health} />;
    case 'sessions':
      return <SessionsPage />;
    case 'workbench':
      return <WorkbenchPage />;
    case 'sku':
      return <SkuDetailPage skuCode={route.param} />;
    case 'suggestions':
      return <SuggestionsPage />;
    case 'plans':
      return <PlansPage />;
    case 'plan-new':
      return <PlanEditorPage planId={null} />;
    case 'plan-edit':
      return <PlanEditorPage planId={route.param} />;
    case 'drafts':
      return <DraftsPage />;
    case 'orders':
      return <OrdersPage />;
    case 'audit':
      return <AuditPage />;
    case 'schedules':
      return <SchedulesPage />;
    case 'assumptions':
      return <AssumptionsPage />;
    default:
      return (
        <EmptyState
          icon="🧭"
          title="页面不存在"
          text={`没有找到路由 #${route.raw}`}
          actions={
            <button type="button" className="ra-btn ra-btn-primary" onClick={() => navigate('/agent')}>
              回到智能助手
            </button>
          }
        />
      );
  }
}

const ROUTE_DESC: Partial<Record<RouteName, string>> = {
  agent: '用自然语言驱动补货：助手只能通过工具取数，写操作只产草稿，提交需人工审批。',
  sessions: '按时间倒序的会话记录，可继续上次对话。',
  workbench: '先看谁危险（风险分级/可售天数/断货日），再看钱压在哪（库存资金），最后勾选转草稿。',
  sku: '单 SKU 四层下钻：库存事实 → 90 天趋势 → 各方案对照 → 解释链与参数来源。',
  suggestions: '按方案生成补货建议；建议数量只读，采购数量可改（偏离系统建议会标 Δ）。',
  plans: '系统默认方案可改不可删；自定义方案可增删改。',
  drafts: '草稿由助手或建议表产出，必须经人工审批才能提交为正式单。',
  orders: '正式采购单 / 要货申请单（提交后进入待审核）。',
  audit: '工具调用、审批、提交等关键动作的只增不改流水。',
  schedules: '定时补货任务：只产草稿，永不自动提交。',
  assumptions: 'H1–H10：每个数字背后未被证实的口径，以及如何证伪。',
};

export function App() {
  const route = useRoute();
  const [navOpen, setNavOpen] = useState(false);

  const health = useAsyncData<HealthInfo>((signal) => apiGet<HealthInfo>('/health', undefined, signal), []);
  const meta = useAsyncData<MetaInfo>((signal) => apiGet<MetaInfo>('/meta', undefined, signal), []);

  useEffect(() => {
    document.title = `${ROUTE_TITLES[route.name] ?? '智能补货'} · 智能补货 Agent`;
    setNavOpen(false);
  }, [route.name]);

  const activePath = useMemo(() => {
    for (const group of NAV_GROUPS) {
      const hit = group.items.find((item) => item.matches.includes(route.name));
      if (hit) return hit.path;
    }
    return '';
  }, [route.name]);

  const refresh = useCallback(() => {
    health.reload();
    meta.reload();
  }, [health, meta]);

  // 后端不可达：整页兜底（不白屏）
  if (health.error && !health.data) {
    return (
      <div className="ra-boot-error">
        <ErrorState
          message={health.error}
          code="NETWORK_ERROR"
          onRetry={refresh}
          extra={
            <div className="ra-hint">
              本页面依赖同源 <code>/api</code>：生产模式请先 <span className="ra-kbd">npm run build</span> 再{' '}
              <span className="ra-kbd">npm start</span>；开发模式请同时运行 <span className="ra-kbd">npm run dev</span> 与{' '}
              <span className="ra-kbd">npm run dev:web</span>。
            </div>
          }
        />
      </div>
    );
  }

  const counts = meta.data?.counts ?? {};
  const today = meta.data?.today ?? health.data?.today ?? '—';
  const isAgent = route.name === 'agent';

  return (
    <div className={`ra-shell${navOpen ? ' ra-nav-open' : ''}`}>
      <aside className="ra-sidebar" aria-label="主导航">
        <div className="ra-brand">
          <div className="ra-brand-logo" aria-hidden="true">
            补
          </div>
          <div className="ra-brand-text">
            <div className="ra-brand-title">智能补货 Agent</div>
            <div className="ra-brand-sub">确定性内核 · 可解释建议</div>
          </div>
        </div>

        <nav className="ra-nav">
          {NAV_GROUPS.map((group) => (
            <Fragment key={group.title}>
              <div className="ra-nav-group">{group.title}</div>
              {group.items.map((item) => (
                <a
                  key={item.path}
                  href={`#${item.path}`}
                  className="ra-nav-item"
                  aria-current={activePath === item.path ? 'page' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(item.path);
                  }}
                >
                  <NavIcon name={item.icon} />
                  <span>{item.label}</span>
                </a>
              ))}
            </Fragment>
          ))}
        </nav>

        <div className="ra-sidebar-foot">
          <div className="ra-brand-sub">v{health.data?.version ?? '2.0.0'} · 服务端零依赖</div>
          <div className="ra-brand-sub">{health.data?.status === 'ok' ? '● 内核与数据层就绪' : '○ 依赖未完全就绪'}</div>
        </div>
      </aside>

      <div className="ra-main">
        <header className="ra-topbar">
          <button type="button" className="ra-nav-toggle" aria-label="切换导航" onClick={() => setNavOpen((open) => !open)}>
            ☰
          </button>
          <div className="ra-topbar-title">
            {ROUTE_TITLES[route.name] ?? '智能补货'}
            <span className="ra-topbar-desc">{ROUTE_DESC[route.name] ?? '补货建议 · 审批 · 审计'}</span>
          </div>
          <div className="ra-topbar-meta">
            <span className="ra-topbar-chip" title="数据日期（域层 asOf 的唯一来源：仓储 meta）">
              {today}
            </span>
            <span className="ra-topbar-chip ra-pill-mono" title="模型（provider / model）">
              {health.data?.provider ?? '—'}/{health.data?.model ?? '—'}
            </span>
            <span className="ra-topbar-chip" title="演示数据规模">
              {fmtInt(counts.store ?? 0)} 门店 · {fmtInt(counts.sku ?? 0)} SKU · {fmtInt(counts.sales_days ?? 0)} 天
            </span>
            <button type="button" className="ra-btn ra-btn-ghost ra-btn-sm" onClick={refresh} title="重新拉取健康状态与元数据">
              刷新
            </button>
          </div>
        </header>

        <main className={`ra-content${isAgent ? ' ra-content-flush' : ''}`}>{renderPage(route, health.data)}</main>
      </div>
    </div>
  );
}

export default App;
