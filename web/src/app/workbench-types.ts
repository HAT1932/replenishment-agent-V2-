/**
 * workbench-types.ts — 决策工作台 / SKU 决策视图的契约类型
 * ---------------------------------------------------------------------------
 * 与 `server/data/workbench.mjs` 的返回一一对应。
 * 注意 `risk_provenance: 'enhancement'`：风险分级/可售天数/断货日/资金占用是**演示增强**，
 * 数量口径仍是 documented，UI 必须显式区分（见 WorkbenchPage 的 CitationStrip）。
 */
import type { Provenance, Assumption } from './types';

export type RiskLevel = '缺货' | '紧急' | '建议' | '滞销' | '充足';

export interface WorkbenchRow {
  sku_id?: string | number;
  sku_code: string;
  sku_no?: string;
  product_name: string;
  spec?: string;
  unit?: string;
  category?: string;
  store_id?: string | number;
  store_name?: string;
  supplier_name?: string;

  on_hand_stock: number;
  sellable_stock: number;
  in_transit_stock: number;
  stock_lower: number;
  stock_upper: number;
  avg_daily_sales: number;
  avg_daily_sales_exact?: number;

  suggest_num: number;
  apply_num: number;
  amount: number;
  unit_cost: number;

  cover_days: number | null;
  stockout_date: string | null;
  risk_level: RiskLevel;
  risk_priority: number;
  risk_reasons: string[];
  inventory_capital: number;

  plan_id?: string | number;
  plan_type?: string;
  provenance?: Provenance;
  risk_provenance: 'enhancement';
  assumptions?: string[];
  flags?: string[];
  guard?: { alert?: boolean; policy?: string; text?: string; passed?: boolean } | null;
}

export interface WorkbenchKpi {
  row_count: number;
  stockout_count: number;
  urgent_count: number;
  suggest_count: number;
  slow_moving_count: number;
  sufficient_count: number;
  low_stock_alert_count: number;
  stale_count: number;
  total_suggest_num: number;
  total_amount: number;
  inventory_capital: number;
  avg_cover_days: number | null;
  stockout_within_7d_count: number;
}

export interface WorkbenchPlanRef {
  plan_id: string | number;
  plan_name: string;
  plan_type: string;
  formula_text?: string;
  provenance?: Provenance;
  config?: Record<string, unknown>;
}

export interface WorkbenchResponse {
  as_of: string;
  expected_arrival?: string;
  plan: WorkbenchPlanRef;
  risk_strategy?: Record<string, number>;
  risk_levels?: RiskLevel[];
  rows: WorkbenchRow[];
  kpi: WorkbenchKpi;
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  skipped?: Array<{ sku_code: string; product_name?: string; code: string; message: string }>;
  sort?: { key: string; order: 'asc' | 'desc' };
  citation?: {
    quantity_provenance?: Provenance;
    decision_provenance?: 'enhancement';
    disclaimer?: string;
  };
  assumptions?: Assumption[];
}

/** SKU 详情里附带的决策视图（/api/sku/:code → data.decision） */
export interface SkuDecision {
  as_of: string;
  plan?: WorkbenchPlanRef;
  suggestion?: Record<string, unknown>;
  risk: {
    level: RiskLevel;
    priority: number;
    reasons: string[];
    cover_days: number | null;
    stockout_date: string | null;
    strategy?: Record<string, number>;
    provenance: 'enhancement';
  };
}
