# 01 · 架构与设计决策（ADR 摘要）

## 1. 为什么是「一个运行时 + 两个入口」

补货这个场景有两个天然触发方式：人想知道"现在该补什么"，和系统该周期性巡检。
如果做成两套代码，就会出现两套口径、两套审计、两套审批——这正是我们审计 v1 时最担心的事。

因此 v2 只有一个 **Agent 运行时**（`server/agent/runtime.mjs`），两条入口只是"谁来发起一轮对话"：

```
Copilot  ──user message──┐
                         ├──► runtime.run({sessionId, userMessage, signal}) ──► tools ──► domain
Scheduler ──synthetic┬───┘                                                        │
                     └──────────────────────────────────────────────────────────► audit
```

`runtime.run` 是唯一能触达工具的地方。工具是唯一能触达领域内核的地方。领域内核是唯一能算数的地方。

## 2. 分层与依赖方向（单向，不允许回流）

```
web ──HTTP/SSE──► server/http/router ──► server/data/queries ──┐
                        │                    server/data/repository ──► SQLite
                        └──► server/agent/runtime ──► tools ──┴──► server/domain（纯函数）
```

- **domain 不依赖任何其它层**：无 IO、无 `Date.now()`、无全局状态。这就是"确定性内核"的形式化定义。
- **repository 只返回数据库形状**，不做业务加工；读模型 `queries` 负责"取数 → 调域层 → 组 KPI/分页"。
- **router 不写业务**：校验 → 调一层 → 包信封（唯一例外是 SSE 流）。
- **web 不算数**：KPI 只用服务端 `kpi`；建议表的"采购数量"是人的输入，不是前端计算。

## 3. Agent 循环（硬约束都在这里，不靠提示词）

`runtime.run` 的每一步：
1. 组装消息（system prompt + 历史转录 + 工具定义）；
2. 调 provider（流式；`reasoning_content` 单独流出，不混入正文）；
3. 若返回 tool_calls → 逐个执行（**每次执行必写审计**：`tool_call` / `tool_result`）；
4. 工具结果回灌上下文，进入下一 step；
5. 直到没有 tool_calls 或触发预算：`MAX_STEPS=8`、单轮工具调用 ≤12、单工具 20s、整轮 180s。

护栏（不是提示词，是代码）：
- 工具层只有两类：**只读** 与 **产草稿**。没有"直接提交"的工具。
- `order.commit` 必须带有效 `approval_id`，且审批状态为 approved、审批与草稿匹配 → 否则返回 `APPROVAL_REQUIRED`。
- 数据过期（`staleness_days > freshness_days`）的 SKU 打 `stale_data` 标记，调度器默认不为其生成草稿。
- provider 失败 → 发 `error` 事件并结束本轮，**不伪造结果**。

## 4. 精度与口径决策（这是本项目最容易被做错的地方）

| 决策 | 原因 | 代码位置 |
|---|---|---|
| 窗口按**自然日**补零，分母恒为 N | v1 的「最后 N 条记录」在缺日数据下会成倍高估（实测 2.0 vs 0.667） | `domain/demand.mjs` |
| 全程 exact 浮点，只在落地 `ceilInt()` 一次 | v1 先 `round4` 再乘天数会系统性多算 1 件（352→363 而非 362） | `domain/suggestion.mjs` |
| 综合系数允许 <1，候选只在"命中项"间取 max | v1 的 `Math.max(1,…)` 会让 0.8 的周末系数静默失效 | `domain/calendar.mjs` |
| 库存缺失 → `DATA_MISSING`，不当 0 | v1 会给出"最大补货量 + 紧急"的假信号 | `domain/inventory.mjs` |
| 日期必须真实日历日 | v1 的 `2026-02-31` 会静默滚到 3 月 | `domain/dates.mjs` |
| 闸门口径显式化（physical / realtime） | 两篇官方文档互相冲突，不能偷偷选一篇当唯一真理 | `domain/safety.mjs` + H4 |

## 5. 数据模型（SQLite，WAL）

```
meta / stores / suppliers / skus / inventory / sales(含 outbound_type)
plans / safety_config / holidays
sessions / messages / artifacts
approvals ──1:1── drafts ──UNIQUE──► orders
audit（append-only） / schedules / runs
```

三个不变量：
1. `orders.draft_id UNIQUE` → 同一草稿重复提交**幂等**（返回同一张单）；
2. `audit` 只增不改，payload 落库前截断（保证永远是合法 JSON）；
3. `meta.seed_end_date` 是"数据日期"的唯一来源——域层从不读系统时钟，回放/测试才能确定性。

## 6. 前端结构

```
App.tsx（外壳：导航 + 顶栏 + 路由）
├─ #/agent  AgentPage（左会话 / 右产物）
│   ├─ ChatPanel：消息流 · 思考折叠 · 工具时间线 · 审批卡 · 输入框
│   └─ ArtifactPanel：按 artifact.kind 回查服务端渲染（suggestions / explain / draft）
├─ #/suggestions  建议表（9 列 + Δ + 逐日系数解释抽屉）
├─ #/plans · #/drafts · #/orders · #/audit · #/schedules · #/assumptions
└─ 共享：DataTable(aria-sort) · Sparkline(useId) · Drawer/Modal(focus trap) · Toast(aria-live)
```

产物面板的纪律：**artifact 只是"一次查询的引用"**（`ref: {as_of, plan_id, …}`），
面板拿 ref 回查 `/api/suggestions` 而不是把整张表塞进事件流——这样刷新/分享后仍然一致。

## 7. 安全与威胁模型

| 威胁 | 现状 |
|---|---|
| API key 泄漏 | 只在 `.env`（gitignore）+ `config.mjs` 内存；`/api/health` 只回 provider/model；日志脱敏 |
| 未授权写操作 | 单机单用户演示；所有写操作需人工审批。**多用户/多租户需要加鉴权层（未做）** |
| 目录穿越 | 静态服务拒绝 `..`/编码穿越（有测试） |
| 请求体攻击 | 2MB 上限 + JSON 解析失败 400 |
| 提示词注入 | 工具参数校验 + 写操作需审批；但**模型输出仍可能误导人** → 所有数字带 provenance/出处 |
| 模型幻觉数字 | 三层防线：工具唯一取数、数字必须引用工具结果、提交需人工签字 |

## 8. 已知取舍

1. **没有鉴权**：演示项目，账号体系未实现。
2. **单仓视角**：跨仓调拨、配销加价、退货冲销未建模（H7）。
3. **调度器是进程内 setInterval**：单实例可用，多实例需要分布式锁。
4. **SSE 无断点续传**：断流后可"重新载入历史"，但不支持 `Last-Event-ID` 重放。
5. **演示数据合成**：seed 固定随机种子，且刻意植入缺日/过期/超卖三类脏数据。

## 9. 可解释性与决策支持（v2.1 补回）

v2 第一版把 v1 的「决策驾驶舱」整体当成"非文档口径"砍掉了，这是判断失误：
砍掉的不只是增强指标，还有**辅助决策**这个职责本身。v2.1 把三件事补回，并划清可信边界。

### 9.1 三个层级（从下往上，越往上越"增强"）

| 层级 | 回答的问题 | 落点 | 溯源标注 |
|---|---|---|---|
| ① 行级解释 | 这一行的数量怎么算出来的？ | 建议表「解释」抽屉：terms / 逐日系数 / 闸门 / 分步推导 | `documented`（数字来自官方口径） |
| ② 决策视图 | 我现在该先处理谁？会断货吗？钱压在哪？ | `#/workbench`：风险分级（缺货/紧急/建议/滞销/充足）+ 可售天数 + 预计断货日 + 库存资金 + 一键转草稿 | 数量 `documented`、风险指标 `enhancement`（页面级声明） |
| ③ 单 SKU 下钻 | 换个方案会怎样？参数从哪来？ | `#/sku/:code`：库存事实 → 90 天趋势 → 4 方案对照 → 解释链与参数来源 | 每个方案各自带 provenance |

### 9.2 新增接口

```
GET /api/workbench?plan_id&risk&sort&order&page&page_size&as_of&keyword
  → { as_of, plan, risk_strategy, risk_levels, rows[], kpi, citation{quantity_provenance,decision_provenance,disclaimer}, assumptions[] }

GET /api/sku/:code
  → { sku, inventory, series(90天), sales_rows, suggestions[4 方案], explain(terms/why/coefficient_detail),
      decision{ risk{level,reasons,cover_days,stockout_date,provenance:'enhancement'} } }
```

### 9.3 风险分级（`server/domain/risk.mjs`，纯函数）

```
缺货 : 有销量且 可售+在途 ≤ 0
紧急 : 需补货且 可售天数 ≤ 3
建议 : 需补货（低库存闸门通过）
滞销 : 日均 < 0.5 且 可售天数 ≥ 90（占资金）
充足 : 其余
```

- 阈值全部参数化（`urgent_cover_days` / `min_daily_sales` / `slow_moving_cover_days`），页面可按业态调；
- **无官方文档依据** → 输出强制带 `provenance:'enhancement'`，页面上以「增强」标签 + 免责声明区分；
- `asOf` 显式传入，不读系统时钟（与内核同纪律，10 个单测覆盖边界：在途延期断货、负可售、阈值覆盖、stale 只记原因）。

### 9.4 为什么「风险分级」不等于「自动决策」

三个理由，也是这套设计的上线前提：
1. 风险阈值是**经验值**，不同业态（生鲜 vs 标品）差异极大，必须可调、可见；
2. 「紧急」只代表**库存维度**紧急，不代表该采购（可能临期、可能待下架、可能谈好调拨）；
3. 所以工作台只做**排序与建议**，把"批量转草稿"做成一次人工动作，提交仍需审批 —— 决策权留给人。
