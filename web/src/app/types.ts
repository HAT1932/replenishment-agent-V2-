/**
 * types.ts — 全量前后端接口类型（唯一事实源：docs/contracts.md §2.5 / §4 / §5 / §6）
 *
 * 约定：
 * - 服务端返回的**可选字段一律 optional**，前端渲染必须容忍缺字段（不许白屏）。
 * - 不在这里定义任何「前端算出来的业务字段」；所有数值均来自 API。
 * - 联合类型只描述契约里明确的取值；服务端多给的值用 `string` 兜底而不是 `any`。
 */

/* ========================================================================== */
/*  基础信封 / 错误                                                            */
/* ========================================================================== */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'DATA_MISSING'
  | 'STALE_DATA'
  | 'APPROVAL_REQUIRED'
  | 'CONFLICT'
  | 'UPSTREAM_LLM_ERROR'
  | 'INTERNAL'
  | 'NETWORK_ERROR'
  | 'ABORTED';

/** 契约 §6：{ ok:false, error:{ code, message, details? } } */
export interface ApiErrorBody {
  code: ErrorCode | string;
  message: string;
  details?: unknown;
  hint?: string;
}

/* ========================================================================== */
/*  §2.6 证据与假设                                                            */
/* ========================================================================== */

/** documented=有官方依据 / enhancement=本实现增强 / assumption=依赖未证实假设 */
export type Provenance = 'documented' | 'enhancement' | 'assumption';

export type Confidence = 'high' | 'medium' | 'low' | 'medium-high' | 'high-risk' | string;

/** 契约 §2.6 ASSUMPTIONS 表（H1–H8） */
export interface Assumption {
  id: string;
  statement: string;
  confidence: Confidence;
  evidence?: string;
  risk?: string;
  probe?: string;
}

/* ========================================================================== */
/*  §2 /api/health、/api/meta                                                 */
/* ========================================================================== */

export interface HealthInfo {
  status?: string;
  service?: string;
  version?: string;
  provider?: string;
  model?: string;
  today?: string;
  node?: string;
}

export interface NamedRef {
  id?: string;
  store_id?: string;
  store_name?: string;
  name?: string;
  code?: string;
}

/** 契约 §2：安全库存配置（固定 / 动态上下限） */
export interface SafetyConfig {
  mode?: 'fixed' | 'dynamic';
  lower_fixed?: number;
  upper_fixed?: number;
  min_sellable_days?: number;
  max_sellable_days?: number;
  freshness_days?: number;
  enabled?: boolean;
  store_id?: string;
  store_name?: string;
}

export interface MetaCounts {
  sku?: number;
  store?: number;
  sales_days?: number;
  supplier?: number;
  category?: number;
  plans?: number;
  [key: string]: number | undefined;
}

export interface MetaInfo {
  today?: string;
  stores?: NamedRef[];
  suppliers?: NamedRef[];
  categories?: string[];
  plans?: Plan[];
  counts?: MetaCounts;
}

/* ========================================================================== */
/*  §2 方案 Plan                                                              */
/* ========================================================================== */

export type PlanType = 'avg_daily' | 'stock_upper' | 'custom';

/** 契约 §2 computeDocumentedSuggestion(plan) 的配置字段 */
export interface PlanConfig {
  purchase_cycle_days?: number;
  coverage_days?: number;
  coefficient_enabled?: boolean;
  weekend_coefficient_enabled?: boolean;
  weekend_coefficient?: number;
  holiday_coefficient_enabled?: boolean;
  holiday_coefficient?: number;
}

export interface Plan {
  plan_id: string;
  plan_name: string;
  plan_type: PlanType | string;
  formula_text?: string;
  provenance?: Provenance;
  config?: PlanConfig;
  remark?: string;
  created_by?: string;
  /** 系统默认方案不可删（契约 §6：系统默认禁删） */
  is_default?: boolean;
  deletable?: boolean;
  created_at?: string;
  updated_at?: string;
}

/* ========================================================================== */
/*  §2.5 Suggestion（建议行稳定契约）                                          */
/* ========================================================================== */

export interface CoefficientDay {
  date: string;
  /** 0=周日 … 6=周六（domain.weekdayIndex） */
  weekday?: number;
  factor: number;
  /** 命中原因，如 ['双休日'] / ['重大节假日']；空数组表示普通工作日 */
  reasons?: string[];
}

export interface SuggestionTerms {
  avg_daily_sales_exact?: number;
  coverage_days?: number;
  purchase_cycle_days?: number;
  stock_lower_exact?: number;
  stock_upper_exact?: number;
  sellable_exact?: number;
  in_transit_exact?: number;
  coefficient_exact?: number;
  on_hand_exact?: number;
  [key: string]: number | undefined;
}

/** 低库存闸门 */
export interface SuggestionGuard {
  passed?: boolean;
  policy?: string;
  text?: string;
  expressions?: string[];
}

/** 建议数量解释步骤 */
export interface WhyStep {
  step?: number | string;
  expr?: string;
  value?: number | string;
  note?: string;
}

export interface Suggestion {
  /* 标识 */
  sku_id?: string;
  store_id?: string;
  store_name?: string;
  sku_code: string;
  sku_no?: string;
  product_name?: string;
  spec?: string;
  unit?: string;
  category?: string;
  supplier_code?: string;
  supplier_name?: string;
  warehouse_code?: string;

  /* 建议表 9 列 */
  stock_upper?: number;
  stock_lower?: number;
  /** 展示值（round4），不参与运算 */
  avg_daily_sales?: number;
  sellable_stock?: number;
  in_transit_stock?: number;
  /** 系统建议数量 = ceil(suggest_raw_exact)，**只读** */
  suggest_num?: number;
  /** 人工采购数量，默认等于 suggest_num，**可编辑** */
  apply_num?: number;

  /* 计算事实（可审计） */
  suggest_raw_exact?: number;
  avg_daily_sales_exact?: number;
  coefficient_exact?: number;
  coefficient_detail?: CoefficientDay[];
  terms?: SuggestionTerms;
  guard?: SuggestionGuard;

  /* 溯源与假设 */
  provenance?: Provenance;
  plan_id?: string;
  plan_name?: string;
  plan_type?: PlanType | string;
  formula_text?: string;
  assumptions?: string[];
  flags?: string[];

  expected_arrival?: string;
  as_of?: string;

  /* 金额（元） */
  unit_cost?: number;
  tax_rate?: number;
  amount?: number;
  tax_amount?: number;

  /* 增强字段（σ 方案才有） */
  sigma_daily?: number;
  sigma_lead_time?: number;
  safety_stock?: number;
  reorder_point?: number;
  target_stock?: number;
  days_of_cover?: number;
  stockout_date?: string;
  risk_level?: string;
}

/** 服务端 KPI 对象（形状由后端决定，前端只展示存在的字段，绝不自行聚合） */
export interface SuggestionsKpi {
  sku_count?: number;
  suggest_sku_count?: number;
  low_stock_count?: number;
  stale_sku_count?: number;
  total_suggest_num?: number;
  total_apply_num?: number;
  total_qty?: number;
  total_amount?: number;
  suggest_amount?: number;
  tax_amount?: number;
  avg_daily_sales?: number;
  [key: string]: number | string | null | undefined;
}

/** 契约 §4 工具 5 / §6 GET /api/suggestions 的返回 */
export interface SuggestionsResponse {
  rows: Suggestion[];
  kpi?: SuggestionsKpi;
  plan?: Plan | null;
  formula_text?: string;
  guard_note?: string;
  as_of?: string;
  expected_arrival?: string;
  provenance?: Provenance;
  assumptions?: string[];
  total?: number;
  page?: number;
  page_size?: number;
  total_pages?: number;
}

/** 契约 §4 工具 6 suggestion.explain 的返回 */
export interface ExplainPayload {
  terms?: SuggestionTerms;
  coefficient_detail?: CoefficientDay[];
  guard?: SuggestionGuard;
  suggest_raw_exact?: number;
  why?: WhyStep[];
  formula_text?: string;
  provenance?: Provenance;
  assumptions?: string[];
}

/* ========================================================================== */
/*  库存 / SKU 详情（§6 GET /api/sku/:code）                                   */
/* ========================================================================== */

export interface InventorySnapshot {
  on_hand?: number;
  locked?: number;
  sellable?: number;
  /* domain 命名为 sellable_exact，两类都兜住 */
  sellable_exact?: number;
  in_transit?: number;
  plan_stock?: number;
  snapshot_date?: string;
  staleness_days?: number;
  status?: string;
}

export interface SalesPoint {
  date: string;
  qty: number;
  outbound_type?: string;
  imputed?: boolean;
}

export interface SkuDetail {
  sku?: Suggestion;
  inventory?: InventorySnapshot | null;
  sales?: SalesPoint[];
  sales_90d?: SalesPoint[];
  curve?: SalesPoint[];
  suggestions?: Suggestion[];
  explain?: ExplainPayload;
}

/* ========================================================================== */
/*  草稿 / 正式单                                                              */
/* ========================================================================== */

export type DraftKind = 'purchase' | 'apply';

export interface DraftItem {
  sku_code?: string;
  sku_id?: string;
  sku_no?: string;
  product_name?: string;
  spec?: string;
  unit?: string;
  /** 人工确认后的采购/要货数量 */
  apply_num?: number;
  suggest_num?: number;
  unit_cost?: number;
  amount?: number;
  tax_rate?: number;
  tax_amount?: number;
}

export interface Draft {
  /** 后端可能用 draft_id 或 id，取到哪个用哪个（见 draftId()） */
  draft_id?: string;
  id?: string;
  kind?: DraftKind | string;
  items?: DraftItem[];
  total_qty?: number;
  total_amount?: number;
  tax_amount?: number;
  status?: string;
  expected_arrival?: string;
  remark?: string;
  session_id?: string;
  approval_id?: string;
  order_id?: string;
  created_at?: string;
  created_by?: string;
}

export interface Order {
  order_id?: string;
  id?: string;
  kind?: DraftKind | string;
  biz_no?: string;
  status?: string;
  total_qty?: number;
  total_amount?: number;
  items?: DraftItem[];
  draft_id?: string;
  created_at?: string;
  operator?: string;
}

export interface ListResponse<T> {
  rows?: T[];
  items?: T[];
  drafts?: T[];
  orders?: T[];
  total?: number;
}

/* ========================================================================== */
/*  审批 Approval（人工闸门，§6）                                              */
/* ========================================================================== */

export type ApprovalDecision = 'approve' | 'reject';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | string;

export interface Approval {
  id: string;
  kind?: string;
  summary?: string;
  risk?: 'medium' | 'high' | string;
  ref?: string;
  status?: ApprovalStatus;
  note?: string;
  draft_id?: string;
  session_id?: string;
  requested_by?: string;
  resolved_by?: string;
  created_at?: string;
  resolved_at?: string;
  /** 批准后可能带回正式单信息 */
  result?: unknown;
}

/* ========================================================================== */
/*  审计                                                                      */
/* ========================================================================== */

export type AuditActor = 'agent' | 'human' | 'scheduler' | string;

export interface AuditEvent {
  id?: string;
  ts: string;
  session_id?: string | null;
  actor?: AuditActor;
  kind?: string;
  tool?: string;
  payload?: unknown;
  ok?: boolean;
  duration_ms?: number;
  provenance?: Provenance | string;
}

/* ========================================================================== */
/*  定时任务 / 会话                                                            */
/* ========================================================================== */

export interface Schedule {
  id: string;
  name?: string;
  cadence?: string;
  plan_id?: string;
  enabled?: boolean;
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_result?: unknown;
  created_at?: string;
}

export interface SessionSummary {
  session_id?: string;
  id?: string;
  title?: string;
  message_count?: number;
  created_at?: string;
  last_message_at?: string;
}

export interface SessionMessage {
  id?: string;
  role?: 'user' | 'assistant' | 'tool' | 'system' | string;
  content?: string;
  text?: string;
  ts?: string;
  created_at?: string;
  reasoning?: string;
  tool_calls?: unknown;
  tool_name?: string;
  ok?: boolean;
}

export interface Artifact {
  id: string;
  kind: 'suggestions' | 'draft' | 'audit' | 'explain' | string;
  title?: string;
  /** 不透明引用：可能是字符串 id，也可能是带参数的对象 */
  ref?: string | Record<string, unknown> | null;
  created_at?: string;
}

export interface SessionDetail {
  session?: SessionSummary;
  messages?: SessionMessage[];
  artifacts?: Artifact[];
}

/* ========================================================================== */
/*  §5 SSE 事件协议                                                            */
/* ========================================================================== */

export type SseEventType =
  | 'session'
  | 'step'
  | 'reasoning_delta'
  | 'assistant_delta'
  | 'tool_call'
  | 'tool_result'
  | 'artifact'
  | 'approval_required'
  | 'usage'
  | 'error'
  | 'done';

/**
 * 流式事件。同一轮内 `seq` 单调递增；前端只依赖 `seq` 排序与 `call_id` 关联。
 * 字段按 type 成组可选（比 11 个窄联合更好用，且不引入 any）。
 */
export interface SseEvent {
  seq: number;
  type: SseEventType;
  /** type=session */
  session_id?: string;
  /** type=step */
  step?: number;
  max_steps?: number;
  /** type=reasoning_delta | assistant_delta */
  text?: string;
  /** type=tool_call | tool_result */
  call_id?: string;
  name?: string;
  args?: unknown;
  /** type=tool_result */
  ok?: boolean;
  duration_ms?: number;
  summary?: string;
  data?: unknown;
  error?: ApiErrorBody | string;
  /** type=artifact */
  artifact?: Artifact;
  /** type=approval_required */
  approval?: Approval;
  /** type=usage */
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  /** type=error */
  code?: string;
  message?: string;
  /** type=done */
  finish_reason?: string;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
}

/* ========================================================================== */
/*  前端内部模型（只描述 UI 状态，不含业务数字）                                */
/* ========================================================================== */

export type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'done' | 'error' | 'aborted';

export interface ToolResultState {
  ok: boolean;
  duration_ms?: number;
  summary?: string;
  data?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export type ChatBlock =
  | { kind: 'user'; id: string; text: string; ts?: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      callId: string;
      name: string;
      args: unknown;
      step?: number;
      status: 'running' | 'done' | 'error';
      result?: ToolResultState;
    }
  | { kind: 'approval'; id: string; approval: Approval; localStatus?: ApprovalStatus; localNote?: string }
  | { kind: 'error'; id: string; code: string; message: string };
