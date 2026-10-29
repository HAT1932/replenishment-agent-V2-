/**
 * Kpi.tsx — KPI 条
 *
 * 纪律：`value` 必须是**服务端 kpi 字段**格式化后的结果（契约 §7 禁止前端凭空造 KPI）。
 * 组件自身不做任何聚合、不做求和。
 */
import type { ReactNode } from 'react';

export type KpiTone = 'danger' | 'warn' | 'ok';

export interface KpiProps {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  foot?: ReactNode;
  tone?: KpiTone;
  /** 数值来源说明（hover 显示），例如「来源：服务端 kpi.low_stock_count」 */
  hint?: string;
}

export function Kpi({ label, value, unit, foot, tone, hint }: KpiProps) {
  const className = `ra-kpi${tone ? ` ra-kpi-${tone}` : ''}`;
  return (
    <div className={className}>
      <div className="ra-kpi-label" {...(hint ? { 'data-tip': hint, tabIndex: 0 } : {})}>
        {label}
      </div>
      <div className="ra-kpi-value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {foot ? <div className="ra-kpi-foot">{foot}</div> : null}
    </div>
  );
}

/** KPI 容器：等宽自适应网格 */
export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="ra-kpi-row">{children}</div>;
}
