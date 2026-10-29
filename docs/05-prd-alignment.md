# 05 · PRD 对齐（v3.x ↔ 实现）

> 目的：把 `草稿/AI_Agent自动补货_PRD_v3.0_精炼版.md` 的每一条，映射到本仓库的具体落点，
> 并**明确写出差异与未做项**。PRD 是产品意图，代码是事实；两者不一致时以本文为准说明差在哪。

## 1. PRD 核心命题 ↔ 实现

| PRD 条目 | 要求 | 本仓库落点 | 状态 |
|---|---|---|---|
| §1 问题①「给数字不解释 → 商家不敢信」 | 建议必须可解释 | 三层解释：`domain/factors.mjs`（因子分解）→ `agent/explain.mjs`（AI 成文 + 数值对账）→ `AiExplainPanel`（前端展示） | ✅ |
| §1 问题③「畅销缺货与滞销积压并存」 | 同时看见补货与滞销 | `#/workbench` 风险分级（缺货/紧急/建议/滞销/充足）+ 库存资金 + 可售天数 | ✅ |
| §2 G2「对接即用」 | POS 授权后自动出建议 | ⚠ 未做 POS 对接：演示数据用固定种子合成（`server/data/seed.mjs`） | ❌ 未做 |
| §3.2 建议量公式（加权日均 × (前置期+目标可售) − 库存 − 在途） | PRD 自建公式 | ⚠ 主口径是**有赞官方三方案**（documented）；PRD 公式的近似实现是 σ 方案（`plan_type=sigma`，标注 enhancement） | 部分 |
| §3.3 安全库存线 = 日均 × (前置期+缓冲) + 三档触发 | 紧急度分级 | `deriveUrgency()`：安全线、×0.5 → 🔴、×1.0 → 🟠、>×1.5 → 🔵 库存偏高；另并入「可售天数 < 前置期 → 置顶」 | ✅ |
| §3.4 异常判定（飙升/骤降/高风险/偏高/缺失…） | 异常标记 | `deriveAnomalies()` 实现 5 类可确定性判定项（spike/drop/stockout_risk/overstock/data_missing）；「促销未录入」「新品」未做 | 部分 |
| §3.5 新店过渡 / §3.6 新品冷启动 | 置信度三档 🟣🟡🟢 | `deriveConfidence()`：按窗口可观测历史 + 新鲜度近似三档；**没有 POS 开店日期**，因此是近似口径（已在返回值里注明 approximation） | 近似 |
| US-01 生成可解释建议（含建议量/库存/销量/可售天数/紧急程度 + 决策因子） | 决策因子解释 | `suggestion.factors`（可加回）+ `confidence` + `urgency` + `anomaly`；`explainSuggestion` 一并返回 | ✅ |
| US-01「商家敢签字」 | 解释要能核对 | `POST /api/explain` 返回 `verification`：模型文本里的每个数字必须能在服务端数据里找到，否则列出未溯源数字 | ✅ |
| US-02 对话追问 + What-if（上下文 ≥5 轮） | 追问与 What-if | 追问走 Agent（会话转录持久化，支持多轮）；What-if 走 `suggestion.whatif` 工具 / `POST /api/whatif` —— **确定性重算**，不是模型估算 | ✅ |
| US-03 审核工作台（批量确认 + 修改 + 撤销） | 审核 | 草稿 → 审批 → 正式单 + 审计；批量转草稿已做；「5 分钟撤销」未做 | 部分 |
| API-06 `/conversation/ask` 返回 `{answer, confidence, factors[], followup}` | 对话接口形状 | Agent 走 SSE（`POST /api/sessions/:id/messages`），`tool_result.meta` 里带 factors/confidence；没有单独的 `/conversation/ask` 端点 | 差异 |
| API-05 店长 ±20% 微调限制 | 门店侧约束 | 未做（当前单人角色） | ❌ |
| §3.8 降级策略（POS 断连/模型不可用） | 降级仍可用 | 模型不可用 → `/api/explain` 自动退化为确定性解释（`source=deterministic`）；数据过期 → `stale_data` 标记 + 调度跳过 | ✅ |
| §6 北极星「日均活跃 ≥60%」 | 埋点 | 未做使用埋点 | ❌ |

## 2. 两个刻意保留的差异

1. **公式口径不是 PRD 公式**：本仓库从「有赞后台逆向 + 官方文档」出发，主口径是三个 documented 方案；
   PRD 的加权日均公式作为 `sigma` 方案的近似实现存在（enhancement）。
   这样做的好处是「每个数字都能说出官方出处」，代价是与 PRD 的公式不完全一致。
   **若要严格按 PRD 公式**：把 `plan_type` 增加 `prd_weighted`，在 `domain/suggestion.mjs` 里接一支独立分支即可（域层已按 plan_type 分派）。
2. **置信度/紧急度/异常是增强指标**：PRD 定义了它们，但没有官方实现口径；本仓库把它们做成纯函数 + 参数可配，
   并在响应里强制标注 `provenance: assumption|enhancement`，避免与 documented 数字混为一谈。

## 3. AI 解释的可信机制（本仓库新增，PRD 未写）

PRD 只要求"可解释"，没规定怎么防模型胡说。本仓库加了三道：

1. **grounding**：只把确定性结果（因子/条款/口径/置信度）塞给模型，模型不许自己算数；
2. **提示词硬规则**：四段固定结构 + 只能引用 JSON 里的数字 + 禁用 markdown + 必须点明口径边界；
3. **数值对账**：`verifyNumbers()` 抽取模型文本里的数字，逐个对照 payload（含规格串里的数量、可推导百分比），
   未溯源的直接返回给前端并以红色徽标展示 —— 宁可显眼地标"未溯源"，也不假装解释可靠。

## 4. 验收对应

| 能力 | 断言位置 |
|---|---|
| 因子可加回 | `test/domain/factors.test.mjs`（四方案恒等式） |
| 解释四段 + 对账 | `test/agent/explain.test.mjs`（含编造数字必须被抓） |
| What-if 确定性 | `test/data/whatif.test.mjs`（改天数必变、改周期只动到货日、越界拒绝） |
| 端到端 | `scripts/verify.mjs` §3.6（4 项：解释结构/对账/What-if 差额/非法参数 400） |
| 页面渲染 | `scripts/shots.mjs`（AI 解读面板 ≥150 字、因子 ≥2 行、What-if 预设存在） |
