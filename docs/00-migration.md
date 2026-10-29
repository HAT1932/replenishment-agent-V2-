# 00 · 迁移决策（v1 → v2）：取什么、改什么、弃什么

> v1 = `E:\REA_SHISHI`（另一个 AI 的有赞逆向 + 复刻）。v2 = 本项目。
> 本文是**唯一迁移台账**：每条结论都能回指 v1 的文件行号，或回指 `E:\Claude_PRD\notes\*-audit.md` 的审计条目。
> 原则：**不 fork 目录、不复制结论、只抽血**。

---

## 0. 一句话结论

v1 值钱的是三类东西——**文档口径的算法骨架**、**"建议→确认"的可信界面范式**、**证据分级与 provenance 纪律**；
不值钱的是它的工程实现（3 个真 bug + 1 套被旧截图撑起来的假设 + 一个 CRUD 后台的壳）。
v2 的做法是：**保留规格与范式，重写实现**。

| 层 | v1 资产 | 决策 | v2 落点 |
|---|---|---|---|
| 算法规格 | 三方案公式、闸门、综合系数、库存四层、单据字段 | ✅ 全带 | `server/domain/{plans,safety,calendar,suggestion}.mjs` |
| 算法实现 | `engine.mjs` 928 行 | 🔧 抽血重写 | 同上（修 D1–D6） |
| 解释体系 | `terms` / `coefficient_detail` / `guard_text` / `provenance` | ✅ 全带并强化 | `Suggestion.{terms,why,guard,assumptions,flags}` |
| Agent 面 | 无 | 🆕 新写 | `server/agent/**` + `web/src/features/agent/**` |
| 数据可信 | 无新鲜度、缺日即错、缺库存当 0 | 🔧 重写 | `demand.mjs` / `inventory.mjs` |
| 前端 | 1,105 行全局 CSS + 10 个页面 | 🔧 带地基重写 | `web/src/styles/{tokens,base,components,features}.css` + feature 目录 |
| 证据方法论 | A/B/C/D 分级、未知登记与撤回 | ✅ 制度化为代码 | `docs/02-provenance.md` + `ASSUMPTIONS` |

---

## 1. ✅ 直接继承（判据：有官方原文/截图双证，或纯数学）

| # | 资产 | v1 出处 | 继承方式 |
|---|---|---|---|
| 1 | 方案 1 公式 `近15天日均销量 × 可售天数 + 库存预警下限 − 可售库存` | `docs/report.md` §4.1；教程 `detail_5_5-2-22065` | 逐字进 `formulaText()` + 单测断言 |
| 2 | 方案 2 公式 `库存上限 − 当前实物库存` | 同上；截图 03 界面文案 | 同上 |
| 3 | 方案 3 公式 `(日均 × 采购周期 + 下限 − 可售 − 在途) × 综合系数` | 同上（双处一致） | 同上 |
| 4 | 日均销量口径（总部含配送+调拨、门店含销售+调拨） | 教程「指标说明」 | 🆕 升级为 `DEMAND_SCOPES` + `outbound_type` 维度 |
| 5 | 采购周期定义 = 相邻两次补货发起间隔 | 教程 + 截图 03 帮助文案 | 参数语义 + 整数校验 |
| 6 | 综合系数算法 + 官方算例 `1.06` | 教程 + 算例 | `coverageCoefficient()` + 单测（用 2018 年日期复现） |
| 7 | 低库存闸门 `实物+在途 < 下限` | 教程 + `73351` | `evaluateLowStockGate()`，口径**显式可切换**（H4） |
| 8 | 库存四层（实物/占用/可售/在途）+ 计划库存 | `doc-inout-overview.md` | `inventorySnapshot()` |
| 9 | 双落点：采购订单（对供应商）/ 要货申请单（对总部） | 教程 + `76702` | `drafts.kind = purchase|apply` |
| 10 | 单据字段语义：`apply_num`、`pre_out/actual_out/actual_in`、`apply_biz_no`、`plan_stock` | `api-*.md` | 草稿/正式单字段 |
| 11 | `ceil` 取整（H1，中等置信） | report §4.5 反算 | `ceilInt()` + 假设登记 + 单测（并**保留改口径的开关**） |
| 12 | 纯数学：z 值(Acklam)、round4、stddev、WMA、斜率、`ceilToPack`、UTC 日期 | `schema.mjs:410-439`、`engine.mjs:38-106,295-302` | `math.mjs` / `dates.mjs`（补严格日期校验） |
| 13 | 官方算例写成单测的做法 | `engine.test.mjs` | 全部继承并扩到 32 条域测试 |

---

## 2. 🔧 改造后带（骨架对，实现错/缺）

| # | v1 资产 | v1 的问题（审计编号） | v2 的做法 |
|---|---|---|---|
| 1 | `avgDailySales()` | **D1**：取「最后 N 条记录」而非「最后 N 个自然日」，无 `asOf` 锚点；缺日数据下建议量可差 5–7 倍；自有 seed 每天落行把 bug 掩盖了 | `demandWindow()`：稠密日期序列 + 缺日补 0 + 分母恒为 N + `staleness_days` |
| 2 | 精度链 | **D2**：先 `round4` 再 ×天数 再 `ceil`，系统性多算 1 件（352 件/15 天 → 363，应为 362；演示 19 个低库存 SKU 中 7 个中招） | 全程 `*_exact` 浮点，只在落地 `ceilInt()` 一次；`snapNearInteger` 消浮点噪声；单测锁定 362 |
| 3 | `coverageCoefficient()` | **D3**：每日候选 `Math.max(1,…)`，<1 的系数被吞（配 0.8 恒得 1） | 候选只在不同命中系数间取 max；单测 0.92 |
| 4 | 库存缺失处理 | **D4**：`inventory` 缺失当 0 库存 → 直接最大补货量 + 误判紧急 | `inventorySnapshot()` 缺库即抛 `DATA_MISSING`，上层跳过并记录 |
| 5 | 日期处理 | **D5**：`'2026-02-31'` 静默滚到 3 月；`expected_arrival='abc'` → API 500 | `dates.mjs` 严格校验真实日历日；到货日必须 ≥ 数据日期 |
| 6 | 出库类型维度 | **D6**：报告称"口径可配置是否计入调拨/配送出库"，**代码里根本没有该维度**（过度声称） | 真正实现：`sales.outbound_type` + `DEMAND_SCOPES` + 工具参数 `include` |
| 7 | `formulaText`（σ 行） | **D7**：文案写「采购周期」，代码用「提前期」 | σ 文案改用「采购提前期」并标 `enhancement` |
| 8 | 采购周期小数 | **D9**：7.5 天 → 公式用 7.5、系数窗口取整成 8 | 强制整数（`VALIDATION_ERROR`） |
| 9 | `applyNumOverride` | **D10**：NaN 进 JSON 变 null、绕过闸门无标记 | 严格校验整数 + `flags:['override']` + 审计留痕（人工决定必须可追溯） |
| 10 | 两套引擎 | **D16**：`computeProposal`（σ 工作台）与 `computeSuggestion` 并存、口径混用、无单测 | 只保留一条 `computeSuggestion` 分派；σ 走独立函数并强制 `provenance='enhancement'` |
| 11 | `service.mjs` 落单层 | 非幂等、单号靠 `COUNT(*)`、`idempotent_no` 不落库 | 草稿→审批→正式单三段式；`orders.draft_id UNIQUE` 保证幂等 |
| 12 | 前端建议表 | 建议数量只读/采购数量可编辑（**好范式**），但 `sku_id` 当行唯一键（跨门店串选）、改「预计到货日」不生效 | 范式保留 + 用 `sku_code`+`store_id` 作键 + 筛选依赖修正 |
| 13 | 前端 KPI 条 / 公式横幅 / SKU 抽屉 | 设计对，但 3 个页面用"当前页数据"算伪 KPI；抽屉四层下钻没消费 `coefficient_detail` | KPI 全部服务端算；横幅升级 Citation strip；抽屉升级解释面板（逐日系数条形图） |
| 14 | CSS token + 数值排版 | token 层好，但 1,105 行全局类名、12 处内联 hex、`id="sparkFill"` 冲突 | 只搬 token 段，CSS 重写为 tokens/base/components/features 四层，`ra-` 前缀 |
| 15 | 测试 | `npm test` 48 条但 `verify.mjs` 用引擎输出反算期望值（自证） | 域测试锁定**官方原文**；API/SSE 测试走真实 HTTP；`--live` 单测真实模型 |

---

## 3. ❌ 不带（明确拒绝）

| 拒绝项 | 原因 |
|---|---|
| `engine.mjs` 原文件 | 3 个真 bug 集中在它身上；重写比 review 便宜 |
| `computeProposal` + σ 工作台第二套引擎 | 无文档依据、无单测、与文档口径混用；v2 只留一条路径 |
| `seed.mjs` 作为**数据源** | 每天落行会掩盖 D1；v2 的 seed 刻意植入缺日/过期/超卖三类脏数据 |
| `service.mjs` 的取数/落单原样 | DB 耦合、全量重算、无入参校验、非幂等 |
| `api.mjs` 无 schema 校验的路由 | v2 手写 `validate.mjs`，错误码机器可读 |
| 1,105 行全局 CSS | 类名污染 + 硬编码；只留 token |
| 前端 `page_size=500` 全量拉取 + 前端排序分页 | 数据量一涨即崩；v2 服务端分页 + KPI |
| 前端"用当前页数据聚合"的伪 KPI | 语义错误（换筛选数字就变）；v2 KPI 一律服务端 |
| 前端 `any` 化路径 | `catch (e: unknown)` + 类型守卫；`tsc --noEmit` 进门禁 |
| 报告 §7「口径可配置」、§0「方案 3 已端到端验证」、§8「3 个方案」等表述 | 与代码/证据不符（算法审计列出 12 处过度声称） |
| `.chrome-profile/`（93.8 MB，含 Cookies） | 与项目无关的交付卫生问题，不迁入 |

---

## 4. 回归用例（v2 必须长期守住）

| 用例 | 值 | 位置 |
|---|---|---|
| D1 缺日：15 自然日仅 5 条记录、共 10 件 | 日均 `0.6667`（不是 2.0） | `test/domain/demand.test.mjs` |
| D2 精度：15 天共 352 件、下限 10 | 建议 `362`（不是 363） | `test/domain/suggestion.test.mjs` |
| D3 系数 <1：双休日系数 0.8、5 天窗口 | 综合系数 `0.92`（不是 1） | `test/domain/safety.test.mjs` |
| 官方算例：周期 5 天、双休 1.1、节假日 1.2 重叠 | `(1+1+1+1.1+1.2)/5 = 1.06` | `test/domain/safety.test.mjs` |
| 闸门边界：下限 0、库存 0 | 不预警（FAQ 口径） | `test/domain/suggestion.test.mjs` |
| 缺库存快照 | 抛 `DATA_MISSING`（不是按 0 算） | `test/domain/suggestion.test.mjs` |
| 非法日期 `2026-02-31` | 抛 `VALIDATION_ERROR` | `test/domain/dates.test.mjs` |
| 无审批提交草稿 | 抛 `APPROVAL_REQUIRED` | `test/data/repository.test.mjs` |
| 重复提交同一草稿 | 幂等返回同一单号 | `test/data/repository.test.mjs` |

---

## 5. 行为差异对照（v1 → v2，用户可感知）

| 场景 | v1 行为 | v2 行为 |
|---|---|---|
| 某 SKU 最近 15 天有 10 天无出库记录 | 日均按 15 条记录算 → 高估 | 缺日补 0，按 15 个自然日算 → 正确 |
| 15 天共 352 件、下限 10 | 建议 363（多 1 件） | 建议 362 |
| 配双休日系数 0.8 | 综合系数恒 1（配置无效） | 0.92（配置生效） |
| SKU 缺库存快照 | 当成 0 库存，给出最大补货量并标"紧急" | 该 SKU 进入 `skipped`，不出假建议 |
| 库存快照 5 天前 | 无提示 | `flags:['stale_data']`，且默认不进自动草稿 |
| 输入 `2026-02-31` | 静默当 3 月 | 400 + `VALIDATION_ERROR` |
| 总部/门店日均口径 | 无区别 | `scope=store|headquarters` 出库类型不同 |
| 补货建议 → 采购单 | 一键落正式单 | 只产草稿；必须人工审批（`approval_id`）后提交 |
| 同一草稿提交两次 | 可能重复建单 | 幂等 |
| 谁改了什么 | 无记录 | 审计表 append-only（工具调用/审批/提交全留痕） |

---

## 6. 遗留与下一步

1. **H1–H8 仍未消解**：需要真实商家账号（见 `docs/03-assumptions.md` 每条的 `probe`）。
2. **有赞无开放接口**（H9）：集成只能 RPA / 自建，v2 不承诺"对接有赞"。
3. **多仓/多组织**：v1/v2 都是单仓视角，跨仓调拨与配销（加价）未建模。
4. **退货/冲销**：日均口径未扣退货（H7），v2 保留为假设而非静默实现。
5. **模型幻觉防线**：当前靠"工具唯一取数 + 数字必须引用工具结果 + 提交需审批"三层；上线前建议再加一层**数值一致性校验器**（把模型输出里的数字与工具结果对账）。

---

## 附录 B · v2.1 修复记录：把「辅助决策」补回来

### B.1 问题

v2 首版把 v1 的增强层（工作台、风险分级、可售天数、断货日、库存资金、SKU 四层下钻）整体判定为
"非官方文档口径 → 不迁移"。事实核查后确认这是一次**过度裁剪**：

- 行级解释（`documented` 公式的 terms/系数/闸门/why）确实保留了，且更严谨；
- 但 v1 真正承担的**决策辅助**职责（谁先补、会不会断货、钱压在哪、换方案会怎样）在 v2 里没有任何落点，
  等于把"AI 辅助决策"降级成了"AI 报数"。

### B.2 修复内容（与 v1 对应关系）

| v1 能力 | v2.1 落点 | 与 v1 的差异 |
|---|---|---|
| 工作台 KPI（风险分布/库存资金/可售天数） | `GET /api/workbench` + `#/workbench` | 风险分级规则**显式化、可配、纯函数单测**；页面级声明"增强" |
| 预计断货日 / 可售天数 | `server/domain/risk.mjs`（含在途） | v1 只看可售；v2 用「可售+在途」避免在途货被误判断货 |
| SKU 四层下钻页 | `#/sku/:code` | 新增「4 方案对照」与「参数来源」，且每行带 provenance |
| 解释抽屉 | 保留 + 扩字段（`explain.why/coefficient_detail` 扁平别名） | 与 SKU 详情共用同一份解释数据 |
| 一键生成草稿 | 工作台勾选批量 → `/api/drafts` | 仍只产草稿，提交必须审批（v1 无审批概念） |

### B.3 回归用例（已加入 `scripts/verify.mjs` 3.5 组）

1. `/api/workbench` 必须返回 5 类风险计数、库存资金、每行 `risk_provenance='enhancement'`、页面级免责声明；
2. `risk` 筛选结果必须与服务端 KPI 一致（防止前端二次过滤口径漂移）；
3. 非法 `risk` → `400 VALIDATION_ERROR` 且 `details.fields[0].field='risk'`；
4. `/api/sku/:code` 必须带 `decision.risk`（provenance=enhancement）、≥2 个方案对照、90 天序列、`explain.why` 非空；
5. 页面渲染断言（headless Chrome）：工作台表格 ≥3 行且 KPI ≥5 张卡；SKU 详情解释链 ≥1 步、曲线 SVG 存在、方案对照 ≥2 行。
