# v2 契约（唯一事实源 · 所有并行开发以此为准）

> 本文件是 v2「智能补货 Agent」的**接口契约**。三条并行开发线（agent / web / platform）都只依赖本文件；
> 任何签名变更必须先改本文件并在群里广播，否则视为破坏性变更。
> 领域知识来源：`E:\REA_SHISHI\docs\report.md` 与 `notes/*-audit.md`（v1 逆向审计）。
> 与 v1 的差异与取舍见 `docs/00-migration.md`。

---

## 0. 产品边界（先定，避免范围漂移）

一个运行时 + 两个入口：

| 入口 | 触发 | 产出 | 强制性护栏 |
|---|---|---|---|
| **Copilot**（对话） | 人在 `#/agent` 提问 | 建议产物（artifact）、草稿单 | 一切写操作只能产出**草稿**；提交需人审批 |
| **Auto**（定时/事件） | `schedules` 到期或手动 run | 待审清单 + 审计事件 | 只生成草稿，**永不自动提交** |

硬规则（runtime 层强制，不依赖提示词）：
1. 计算只能走确定性工具（`server/domain`），LLM 不得自算数字；
2. 写操作工具只产 `draft`，`order.commit` 必须携带有效 `approval_id`；
3. 每个数字必须带 `provenance` 与 `assumptions`（见 §2.6）；
4. 数据过期（`staleness_days > freshness_days`）的 SKU 默认不进自动草稿。

---

## 1. 目录与写入归属（避免并行冲突）

| 归属 | 目录/文件 | 说明 |
|---|---|---|
| **Lead** | `server/domain/**`、`server/data/**`、`test/domain/**`、`docs/**`、根配置 | 确定性内核 + 数据层 + 契约 |
| **agent-dev** | `server/agent/**`、`server/providers/**`、`server/prompts/**`、`test/agent/**` | 运行时、工具、Provider、调度器 |
| **web-dev** | `web/**`（含 `web/src/**`）、根 `index.html` | 全部前端 |
| **platform-dev** | `server/index.mjs`、`server/http/**`、`scripts/**`、`test/api/**` | HTTP/SSE、静态服务、验收脚本 |

> 不要跨域写文件。需要跨域改动时先在群里说明，由该域 owner 改。

---

## 2. 领域内核 `server/domain/index.mjs`（Lead 提供，agent-dev 只消费）

全部**纯函数**：无 IO、无 `Date.now()`（时间一律由参数传入）、无全局状态。抛出 `DomainError`。

```js
// ---- 错误 ----
class DomainError extends Error { code; details }          // code: VALIDATION_ERROR | DATA_MISSING | STALE_DATA

// ---- 日期（UTC，严格校验）----
isValidDate(s) -> boolean                                   // 'YYYY-MM-DD' 且真实日历日（2026-02-31 → false）
addDays(date, n) -> 'YYYY-MM-DD'
diffDays(a, b) -> number                                    // b - a
weekdayIndex(date) -> 0..6                                  // 0=周日

// ---- 需求窗口（修 v1 的 D1）----
/**
 * 近 N 个「自然日」的需求窗口，缺日按 0 补，带新鲜度。
 * @param {{ sales: Array<{date,qty,outbound_type?}>, asOf: string, days?: number,
 *           include?: Array<'sale'|'transfer'|'delivery'>, freshness_days?: number }} input
 * @returns {{ asOf, days, avg_daily_exact, total, points: Array<{date,qty,imputed:boolean}>,
 *             recorded_days, imputed_days, last_recorded_date, staleness_days,
 *             status: 'ok'|'stale', include, assumptions: string[] }}
 */
demandWindow(input)

// ---- 库存四层 ----
/** @returns {{ on_hand, locked, sellable_exact, in_transit, plan_stock, snapshot_date, staleness_days }} */
inventorySnapshot(inv, { asOf, freshness_days? })          // inv 缺失 → 抛 DATA_MISSING

// ---- 预警上下限（修 v1 的取整歧义：内部 exact，落地才取整）----
/**
 * @param {{ config: {mode:'fixed'|'dynamic', lower_fixed, upper_fixed,
 *            min_sellable_days, max_sellable_days}, avg_daily_exact: number }} input
 * @returns {{ mode, lower_exact, upper_exact, lower:int, upper:int, formula_text, assumptions: string[] }}
 */
resolveSafetyStock(input)

// ---- 低库存闸门（修 v1 「两篇官方文档冲突」：口径显式化）----
/**
 * @param {{ stock_num, in_transit, stock_lower, policy?: 'physical_plus_transit'|'realtime' }} input
 * @returns {{ alert: boolean, policy, text, expressions: string[] }}
 */
evaluateLowStockGate(input)

// ---- 日历综合系数（修 v1 的 D3：允许 <1）----
/**
 * 逐日系数 = max(命中的已启用系数)；都没命中 = 1。**不再隐含 max(1,…) 地板**。
 * 窗口 = [arrivalDate, arrivalDate + cycleDays - 1]（闭区间，cycleDays 必须为正整数）
 * @returns {{ coefficient_exact, days, total_exact, series: Array<{date,weekday,factor,reasons:string[]}>, assumptions:string[] }}
 */
coverageCoefficient(input)

// ---- 主计算：文档口径三方案 ----
/**
 * @param {{
 *   plan: {plan_type:'avg_daily'|'stock_upper'|'custom', purchase_cycle_days, coverage_days,
 *          coefficient_enabled, weekend_coefficient_enabled, weekend_coefficient,
 *          holiday_coefficient_enabled, holiday_coefficient},
 *   sku, inventory, sales, safetyConfig, holidays?: string[],
 *   asOf, expectedArrival?, applyNumOverride?
 * }} input
 * @returns {Suggestion}   // 字段见 §2.5
 */
computeDocumentedSuggestion(input)

// ---- 增强：σ 方案（provenance='enhancement'，与文档口径严格分离）----
computeSigmaSuggestion(input) -> Suggestion

// ---- 预测（σ 方案内部使用，也可单独作为工具）----
forecastDemand({ sales, asOf, params }) -> { forecast_daily_exact, base_wma_exact, trend_exact,
   trend_adj_exact, horizon_factor, weekday_factors, seasonality_enabled, window, observations, assumptions }

// ---- 数学/取整 ----
roundTo(n, digits) -> number
ceilInt(n) -> number                                        // 建议数量落地：向上取整
ceilToPack(raw, pack_size, moq) -> number                   // σ/采购落地用
safetyStock({ sigma_lead_time, forecast_daily, service_level, safety_days }) -> {...}
reorderPoint(...), daysOfCover(...), stockoutDate(...), stddev(...), linearSlope(...),
weightedMovingAverage(...), zFromServiceLevel(p), classifyRisk(...), detectSlowMoving(...), summarize(...)

// ---- 文案 / 常量 / 假设登记 ----
formulaText(plan) -> string                                 // 方案 1–3 与官方原文逐字一致
coefficientHint(plan) -> string
PLAN_TYPES, PLAN_TYPE_LABEL, PLAN_TYPE_ORDER, PROVENANCE,
DEFAULT_PLAN_CONFIG, DEFAULT_SAFETY_STOCK, AVG_SALES_WINDOW=15,
ASSUMPTIONS: Array<{ id, statement, confidence:'high'|'medium'|'low', evidence, risk, probe }>
```

### 2.5 `Suggestion`（建议行的**稳定契约**，前后端/工具共用）

```js
{
  // 标识
  sku_id, store_id, store_name, sku_code, sku_no, product_name, spec, unit, category,
  supplier_code, supplier_name, warehouse_code,
  // 表格 9 列（与官方截图同序同义）
  stock_upper, stock_lower, avg_daily_sales,      // avg_daily_sales = 展示值（round4），不参与运算
  sellable_stock, in_transit_stock, suggest_num, apply_num, unit,
  // 计算事实（可审计）
  suggest_raw_exact, avg_daily_sales_exact, coefficient_exact, coefficient_detail[],
  terms: { avg_daily_sales_exact, coverage_days|purchase_cycle_days, stock_lower_exact,
           sellable_exact, in_transit_exact, coefficient_exact },
  guard: { passed, policy, text, expressions: [] },
  // 溯源与假设
  provenance: 'documented'|'enhancement',
  plan_id, plan_name, plan_type, formula_text,
  assumptions: string[],                            // 引 ASSUMPTIONS 的 id
  flags: string[],                                  // 'stale_data' | 'negative_sellable' | 'override' | 'slot_risk'
  expected_arrival, as_of,
  // 金额
  unit_cost, tax_rate, amount, tax_amount,
  // 增强字段（σ 方案才有）
  sigma_daily?, sigma_lead_time?, safety_stock?, reorder_point?, target_stock?, days_of_cover?, stockout_date?, risk_level?
}
```

> **精度纪律（修 D2）**：运算全程 `*_exact` 浮点，`suggest_num = ceilInt(suggest_raw_exact)` 只在最后一步；
> 展示值 `avg_daily_sales` 用 `roundTo(exact,4)`，**绝不回代**。

### 2.6 证据与假设标记（每个数字都要能自证）

`provenance` 取值：
- `documented` —— 有 official 文档/截图证据（方案 1/2/3、闸门、系数、15 天窗口）
- `enhancement` —— 本实现增强（σ 方案、预测、风险分级、部分补货、装箱/MOQ）
- `assumption` —— 依赖未证实假设，必须同时列 `assumptions:['H3']`

`ASSUMPTIONS` 初版（来自 `notes/evidence-audit.md` §6.2，由 Lead 维护）：

| id | 假设 | 置信度 | 翻盘影响 |
|---|---|---|---|
| H1 | `建议数量 = ceil(公式)` | medium | 单点证据；若可售天数=8 则 round 复活 |
| H2 | 统计窗口 = 近 15 个自然日（含零销量日） | medium-high | UI 曾出现 16 天；差 6.7% |
| H3 | 综合系数窗口 = `[到货日, 到货日+周期−1]` 闭区间 | medium | 文字描述与算例矛盾 |
| H4 | 低预警判定 = `实物+在途 < 下限`（可选 `realtime` 口径） | high-risk | 两篇官方文档冲突 |
| H5 | 动态上下限取整 | low | 文档只给乘法 |
| H6 | 方案 2 的「实物库存」不减占用/在途 | medium | 文档仅 5 字 |
| H7 | 日均销量含零销量日、不冲减退货 | medium | 文档未定义 |
| H8 | 建议数量 ≤0 不展示 | low | 纯工程推断 |

---

## 3. 数据层 `server/data/repository.mjs`（Lead 提供）

```js
openDb(path) -> db                     // node:sqlite；首次自动 seed
getMeta(db) -> { today, stores[], suppliers[], categories[], plans[], counts{} }
listSkus(db, { store_id?, category?, keyword?, limit? }) -> sku[]
getSkuByCode(db, sku_code) -> sku
getInventory(db, sku_id) -> inventory | null
getSales(db, sku_id, { from, to }) -> {date,qty,outbound_type}[]
getSafetyConfig(db, { store_id? }) -> config
listHolidays(db) -> ['YYYY-MM-DD']
listPlans(db) / getPlan(db, plan_id)
getSkuCounts(db) -> { sku, store, sales_days }
// 写入
createOrderDraft(db, {kind:'purchase'|'apply', items, expected_arrival, remark, session_id, created_by}) -> draft
getDraft(db, id) / listDrafts(db, q) / commitDraft(db, id, {approval_id, operator}) -> order
createOrdersFromDraft(...)             // 幂等：draft_id 唯一
appendAudit(db, event) / searchAudit(db, {session_id?, kind?, limit?})
// 审批（人工闸门；与草稿 1:1）
createApproval(db, {session_id, draft_id, kind:'order_commit', summary, risk, requested_by}) -> approval
getApproval(db, id) / listApprovals(db, {session_id?, status?}) / resolveApproval(db, id, {decision:'approve'|'reject', note, operator})
saveSchedule(db, ...) listSchedules(db) markScheduleRun(db, id, result)
// 会话
createSession(db, {title}) / getSession / listSessions / appendMessage / listMessages / saveArtifact / getArtifact
```

`appendAudit` 事件形状：`{ id, ts, session_id, actor:'agent'|'human'|'scheduler', kind, tool?, payload, ok, duration_ms, provenance? }`。

---

## 4. 工具契约（agent-dev 实现；名称/参数/返回**冻结**）

统一返回信封：

```js
{ ok: true,  data, meta: { tool, duration_ms, provenance, assumptions, as_of } }
{ ok: false, error: { code, message, hint? } }          // code 同 HTTP 错误码
```

| # | 名称 | 入参（JSON Schema） | 返回 | 写？ |
|---|---|---|---|---|
| 1 | `catalog.list_skus` | `{store_id?, category?, keyword?, limit?}` | `{skus:[{sku_code,sku_no,product_name,spec,unit,category,store_id,store_name}]}` | 否 |
| 2 | `inventory.get` | `{sku_code}` | `{sku_code, on_hand, locked, sellable, in_transit, plan_stock, snapshot_date, staleness_days, status}` | 否 |
| 3 | `demand.window` | `{sku_code, days?, as_of?, include?}` | `demandWindow()` 结果 | 否 |
| 4 | `safety.resolve` | `{sku_code, store_id?}` | `resolveSafetyStock()` 结果 + `avg_daily_sales_exact` | 否 |
| 5 | `suggestion.compute` | `{plan_id?, plan?, store_id?, sku_codes?, category?, keyword?, as_of?, expected_arrival?, only_low?}` | `{as_of, expected_arrival, formula_text, plan:{...}, rows:[Suggestion], kpi, guard_note}` | 否 |
| 5.5 | `workbench.get` | `{risk?, plan_id?, keyword?, store_id?, as_of?, sort?, order?, limit?}` | `{as_of, plan, risk_levels, risk_strategy, kpi, total, top:[{sku_code, risk_level, cover_days, stockout_date, inventory_capital, ...}], citation}` | 否（但风险指标为 enhancement 口径，meta 带 H10） |
| 6 | `suggestion.explain` | `{sku_code, plan_id?, plan?}` | `{terms, coefficient_detail, guard, suggest_raw_exact, why:[{step,expr,value,note}]}` | 否 |
| 6.5 | `suggestion.whatif` | `{sku_code, plan_id?, as_of?, overrides:{purchase_cycle_days?|coverage_days?|safety_days?|service_level?}}` | `{before, after, delta, factor_delta, arrival{...}, parameter_effects, overrides{applied,rejected}}` | 否（确定性重算，非模型估算） |
| 7 | `plan.list` | `{}` | `{plans:[{plan_id,plan_name,plan_type,formula_text,provenance,config}]}` | 否 |
| 8 | `order.create_draft` | `{kind:'purchase'\|'apply', items:[{sku_code,apply_num}], expected_arrival?, remark?}` | `{draft_id, kind, items, total_qty, total_amount, status:'draft'}` | **草稿** |
| 9 | `order.commit` | `{draft_id, approval_id}` | `{order_id, kind, biz_no, status}` | **必须审批** |
| 10 | `order.list_drafts` | `{status?}` | `{drafts:[...]}` | 否 |
| 11 | `audit.search` | `{session_id?, kind?, limit?}` | `{events:[...]}` | 否 |
| 12 | `schedule.list` | `{}` | `{schedules:[{id,name,cadence,plan_id,enabled,last_run_at,next_run_at}]}` | 否 |
| 13 | `schedule.trigger` | `{schedule_id}` | `{run_id, draft_ids, summary}` | **草稿** |
| 14 | `assumption.list` | `{}` | `{assumptions: ASSUMPTIONS}` | 否 |

**工具描述文本**必须写清「口径/假设/返回单位」，因为这会直接进模型上下文。写操作工具的描述里必须出现「只生成草稿，需人工审批后提交」。

---

## 5. Agent 运行时（agent-dev 实现；platform/web 消费）

```js
// server/agent/runtime.mjs
createRuntime({ db, provider, tools, clock, limits }) -> runtime
runtime.run({ sessionId, userMessage, onEvent }) -> Promise<{ finish_reason, usage }>

// server/agent/providers/index.mjs
createProvider(env) -> { name, model, chat({messages, tools, signal, onDelta}) -> {message, usage}, supportsStreaming }

// server/agent/scheduler.mjs
runDueSchedules({ db, runtime, now }) -> {runs:[...]}
computeNextRun(cadence, from) -> iso
```

运行时硬约束（必须实现，且要有测试）：
- 最多 `MAX_STEPS=8` 步工具循环、`MAX_TOOL_CALLS_PER_TURN=12`、单工具超时 `20s`、整轮预算 `120s`；
- 每次工具调用**必写审计**（成功与失败都写）；
- `order.commit` 无有效 `approval_id` → 直接拒绝（不交给模型判断）；
- Provider 失败 → 发 `error` 事件并结束，不伪造结果；
- `provider='mock'` 时用确定性脚本回放（测试用），与真实 provider 走同一事件协议。

### SSE 事件协议（`text/event-stream`，每行 `data: {json}\n\n`）

```js
{ seq, type:'session',      session_id }
{ seq, type:'step',        step, max_steps }
{ seq, type:'reasoning_delta', text }        // 模型 reasoning_content（可折叠展示）
{ seq, type:'assistant_delta', text }
{ seq, type:'tool_call',    call_id, name, args, step }
{ seq, type:'tool_result',  call_id, name, ok, duration_ms, summary, data?, error? }
{ seq, type:'artifact',     artifact:{ id, kind:'suggestions'|'draft'|'audit'|'explain', title, ref } }
{ seq, type:'approval_required', approval:{ id, kind:'order_commit', summary, risk:'medium'|'high', ref } }
{ seq, type:'usage',        prompt_tokens, completion_tokens, reasoning_tokens }
{ seq, type:'error',        code, message }
{ seq, type:'done',         finish_reason }
```

同一轮内的 `seq` 单调递增；前端只依赖 `seq` 排序与 `call_id` 关联。

---

## 6. HTTP API（platform-dev 实现；web 消费）

统一响应信封：成功 `{ ok:true, data }`；失败 HTTP 4xx/5xx + `{ ok:false, error:{ code, message, details? } }`。
错误码：`VALIDATION_ERROR | NOT_FOUND | DATA_MISSING | STALE_DATA | APPROVAL_REQUIRED | CONFLICT | UPSTREAM_LLM_ERROR | INTERNAL`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{status, service, version, provider, model, today, node}` |
| GET | `/api/meta` | 门店/供应商/分类/方案/计数 |
| GET | `/api/assumptions` | `ASSUMPTIONS` |
| POST | `/api/sessions` | `{title?}` → `{session_id}` |
| GET | `/api/sessions` | 列表（含 last_message_at） |
| GET | `/api/sessions/:id` | `{session, messages[], artifacts[]}` |
| DELETE | `/api/sessions/:id` | 删除会话与消息（保留审计） |
| POST | `/api/sessions/:id/messages` | `{content}` → **SSE**（§5 协议） |
| POST | `/api/sessions/:id/approvals/:approval_id` | `{decision:'approve'\|'reject', note?}` → `{approval, result?}` |
| GET | `/api/approvals?status=` | 审批列表（含 pending） |
| GET | `/api/plans`、`/api/plans/:id` | 方案 |
| POST/PUT/DELETE | `/api/plans[/:id]` | 方案增改删（系统默认禁删） |
| GET | `/api/suggestions` | `plan_id,store_id,category,keyword,as_of,expected_arrival,only_low,page,page_size` → `{rows,kpi,plan,formula_text,...}` |
| `POST /api/explain` | body `{sku_code, plan_id?, as_of?, session_id?}` | `{explanation:{text, source: 'llm'|'deterministic', model, degraded, verification:{ok, checked, grounded, unknown[]}, generated_at}, grounding:{factors, factor_identity, confidence, urgency, anomaly, plan, formula_text, assumptions}}` |
| `POST /api/whatif` | body `{sku_code, plan_id?, as_of?, overrides:{purchase_cycle_days?|coverage_days?|safety_days?|service_level?}}` | `{before, after, delta:{qty, amount, qty_pct}, factor_delta[], arrival:{before,after,changed}, parameter_effects, overrides:{applied,rejected}}` |
| GET | `/api/sku/:code` | SKU 详情：库存四层 + 90 天曲线 + 各方案建议 + 解释 |
| GET | `/api/inventory`、`/api/safety-stock`（GET/PUT）、`/api/holidays`（GET/POST/DELETE） | 基础数据 |
| GET | `/api/drafts`、`/api/drafts/:id` | 草稿 |
| POST | `/api/drafts` | `{kind, items:[{sku_code, apply_num}], expected_arrival?, remark?, session_id?}` → 201 `{draft}`（**只产草稿**，不提交） |
| POST | `/api/drafts/:id/commit` | `{approval_id}` → 正式单（幂等） |
| GET | `/api/orders?kind=purchase\|apply` | 正式单 |
| GET | `/api/audit` | `session_id?,kind?,limit` |
| GET | `/api/schedules`、POST `/api/schedules/:id/run` | 定时任务 |

静态：`GET /` 与 `GET /*` 回 `dist/`（SPA fallback），`/api/*` 优先。

---

## 7. 前端契约（web-dev）

hash 路由：`#/agent`（会话，默认）`#/sessions` `#/suggestions` `#/plans` `#/orders` `#/drafts` `#/audit` `#/schedules` `#/assumptions`。

**`#/agent` = 左会话 / 右产物（核心页）**
- 左栏：消息流；`reasoning_delta` 折叠在「思考」块；`tool_call`/`tool_result` 渲染成**时间线卡片**（工具名、参数、耗时、成功/失败、可展开原始 JSON）；输入框（Enter 发送、Shift+Enter 换行）；`approval_required` 渲染成**审批卡**（摘要 + 风险 + 批准/驳回 + 备注）。
- 右栏：当前 artifact（建议表 / 草稿 / 解释面板），可切换。
- 顶部：模型名、会话 id、token 用量、`连接状态`。

**必带（从 v1 迁移，见 `docs/00-migration.md`）**：
1. token 层 + `tabular-nums` 数值排版 + KPI 条；
2. 建议表「建议数量只读 / 采购数量可编辑 + Δ 偏离标记」；
3. 公式横幅 → **Citation strip**（`documented`/`enhancement`/`assumption` 三态 + 可点开出处与假设）；
4. SKU 抽屉四层下钻 → 解释面板（消费 `coefficient_detail.reasons` 画逐日系数小图）；
5. 表格四态 + 分页 + 排序 + CSV 导出。

**禁止**：前端自算业务数字；前端凭空造 KPI（必须来自服务端 `kpi`）。

---

## 8. 完成定义（DoD）

1. `npm run build` 通过；`npm run typecheck` 通过（`tsc --noEmit`，`strict: true`）。
2. `node --test test/domain` 全绿，且包含 **D1/D2/D3 回归用例**（见 `docs/00-migration.md` §4）。
3. `node --test test/agent` 用 **mock provider** 跑通：多步工具 → 草稿 → 审批卡 → 提交（含「无审批被拒」用例）。
4. `npm run verify` 对**真实启动的服务**做 HTTP 验收；`provider=deepseek` 时额外跑一轮真实对话（可用 `--live` 开关，默认 mock）。
5. `#/agent` 能真实走完一次：提问 → 工具时间线 → 建议表 → 建草稿 → 审批 → 提交 → 审计可见。
6. `docs/` 齐：`00-migration.md`（取/改/弃 + 回归）、`01-architecture.md`、`02-provenance.md`、`03-assumptions.md`、`04-runbook.md`。

---

## 9. 约定

- 全部源码 UTF-8、ESM、中文注释（对外文案中文）。
- 服务端**零第三方依赖**（`node:sqlite`/`node:http`/全局 `fetch`）；前端只允许 react/react-dom + vite 工具链。
- 时间一律显式传入；禁止在 domain 层读系统时钟。
- 金额用「分」还是「元」：**元（number，最多 2 位小数）**，展示与接口一致。
- 提交信息/日志/前端展示**不得**出现 API key；`.env` 不入库。
