/**
 * States.tsx — 空态 / 错误态 / 加载态（**每个页面都必须有文案，不允许白屏**）
 *
 * 错误态区分两类：
 *  - 连接失败（后端未启动 / 代理不通）→ 给出具体启动命令
 *  - 业务错误（VALIDATION_ERROR / NOT_FOUND …）→ 直接展示后端 message
 */
import type { ReactNode } from 'react';

export interface ErrorStateProps {
  message: string;
  code?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  /** 附加说明（如「会话历史仍可查看」） */
  extra?: ReactNode;
  compact?: boolean;
}

function looksLikeNetworkFailure(message: string): boolean {
  return /无法连接|无法建立|ECONNREFUSED|Failed to fetch|NetworkError|请求超时/i.test(message);
}

export function ErrorState({ message, code, onRetry, retryLabel = '重新加载', extra, compact }: ErrorStateProps) {
  const offline = code === 'NETWORK_ERROR' || looksLikeNetworkFailure(message);

  return (
    <div className="ra-empty" role="alert" style={compact ? { padding: '24px 16px' } : undefined}>
      <div className="ra-empty-icon" aria-hidden="true">
        {offline ? '🔌' : '⚠️'}
      </div>
      <div className="ra-empty-title">{offline ? '后端连接失败' : '加载失败'}</div>
      <div style={{ maxWidth: 620, lineHeight: 1.7 }}>{message}</div>
      {offline ? (
        <div className="ra-hint" style={{ maxWidth: 620 }}>
          排查顺序：① 后端是否已启动 <span className="ra-kbd">npm run dev</span>（默认 3200 端口）；②
          <span className="ra-kbd">npm run dev:web</span> 是否在 5273 且 <code>/api</code> 代理指向
          <span className="ra-kbd">http://127.0.0.1:3200</span>；③ <span className="ra-kbd">/api/health</span>{' '}
          是否返回 <code>{'{ ok: true }'}</code>。
        </div>
      ) : null}
      {code ? <div className="ra-faint ra-xs">错误码：{code}</div> : null}
      <div className="ra-empty-actions">
        {onRetry ? (
          <button type="button" className="ra-btn ra-btn-primary ra-btn-sm" onClick={onRetry}>
            {retryLabel}
          </button>
        ) : null}
        <button type="button" className="ra-btn ra-btn-sm" onClick={() => window.location.reload()}>
          刷新页面
        </button>
      </div>
      {extra}
    </div>
  );
}

export interface EmptyStateProps {
  title?: ReactNode;
  text?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ title, text, icon = '📦', actions, compact }: EmptyStateProps) {
  return (
    <div className="ra-empty" style={compact ? { padding: '28px 16px' } : undefined}>
      <div className="ra-empty-icon" aria-hidden="true">
        {icon}
      </div>
      {title ? <div className="ra-empty-title">{title}</div> : null}
      {text ? <div style={{ maxWidth: 560, lineHeight: 1.7 }}>{text}</div> : null}
      {actions ? <div className="ra-empty-actions">{actions}</div> : null}
    </div>
  );
}

export function LoadingBlock({ text = '正在加载…' }: { text?: string }) {
  return (
    <div className="ra-loading-block" role="status" aria-live="polite">
      <span className="ra-spinner" aria-hidden="true" />
      {text}
    </div>
  );
}

export type AlertTone = 'ok' | 'warn' | 'danger' | 'info';

export function InlineAlert({
  tone = 'info',
  children,
  actions,
}: {
  tone?: AlertTone;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`ra-alert ra-alert-${tone}`}>
      <div className="ra-grow">{children}</div>
      {actions ? <div className="ra-row ra-gap-2">{actions}</div> : null}
    </div>
  );
}
