# 02 · 证据分级与 provenance 规范

> 本文件规定：**一个数字凭什么叫「有依据」**。它是 v1 方法论（A/B/C/D 分级 + 未知登记与撤回）的制度化版本。

---

## 1. 三档 provenance（接口里机器可判）

| 取值 | 含义 | 允许出现在 | 界面表现 |
|---|---|---|---|
| `documented` | 有官方文档正文或后台真实截图证据 | 方案 1/2/3、闸门、综合系数、库存四层、单据字段 | 绿色「有赞文档已证实」 |
| `enhancement` | 本实现增强，**不是**有赞行为 | σ 方案、需求预测、风险分级、装箱/MOQ、趋势 | 蓝色「[增强]」 |
| `assumption` | 依赖未证实假设，必须同时给 `assumptions:['H1'…]` | 任何引用 H1–H8 的结论 | 橙色「依赖假设」+ 可点开 |

规则：
1. **禁止把 `enhancement` 写成 `documented`**（v1 README 把 ceil 紧挨着"文档已证实"段落，是反例）。
2. **任何 `assumption` 结论必须能在 `#/assumptions` 找到对应 H 编号**，且该条要有 `probe`（如何证伪）。
3. 一个结论可以有多个 provenance（例如「建议数量」= documented 公式 + H1 取整假设 + H2 窗口假设），
   接口里体现为 `provenance` + `assumptions[]` 两个字段并列。

---

## 2. 证据等级（沿用 v1 的 A/B/C/D，但收紧使用）

| 等级 | 形态 | 本项目的使用 |
|---|---|---|
| **A** | 官方帮助中心正文（含公式、口径、示例） | 三方案公式、日均口径、闸门、系数算法 |
| **B** | 官方后台真实截图 | 界面信息架构、9 列表格、建议数量只读/采购数量可改 |
| **C** | 有赞云开放平台接口契约 | 单据字段名与语义（`apply_num`、`pre_out_num`…） |
| **D** | 工程推断 | 取整 `ceil`、窗口闭区间、默认到货日、≤0 不展示 |

**已知的等级陷阱（v1 踩过，v2 禁止重演）**：
- **A 级自相矛盾**：教程写 15 天、同款弹窗文案出现 16 天；低预警口径两篇 A 级文档打架 → 冲突必须
  显式登记为假设（H2/H4），不能"取一篇当权威"。
- **单样本反算不能说"唯一自洽"**：`ceil` 只有一行数据支撑，且显示值已舍入 → 只能算 D 级（H1）。
- **A 级文档 ≠ 规格书**：帮助中心是写给商家的操作教程，不是规格。凡属"教程没写、只能猜"的，一律 D。
- **旧证据**：v1 的核心截图是 2019–2021 年上传，而 2024 年官方已改路径 → 证据要标日期与版本风险。

---

## 3. 本项目里 provenance 的落点（可 grep）

| 位置 | 字段 | 说明 |
|---|---|---|
| `Suggestion.provenance` | `documented` / `enhancement` | 每条建议一行 |
| `Suggestion.assumptions` | `['H1','H2','H4'…]` | 该行结论依赖的假设 |
| `Suggestion.flags` | `stale_data` / `negative_sellable` / `override` / `gate_closed` | 数据质量与人工介入痕迹 |
| `Suggestion.guard` | `{alert, policy, text, expressions}` | 闸门判定的自然语言 + 表达式（可审计） |
| `Suggestion.why` | 分步推导 | 窗口→库存→预警→闸门→公式 |
| `server/domain/assumptions.mjs` | `ASSUMPTIONS` 常量 | H1–H10 唯一事实源（接口 `/api/assumptions`） |
| 工具返回 `meta.provenance/assumptions/as_of` | 每次工具调用 | 让模型的每个数字都能回溯 |

---

## 4. 未知 ≠ 假设

| | 假设（assumption） | 未知（unknown） |
|---|---|---|
| 定义 | 我们**选择**了一个口径继续推进 | 我们**不知道**事实是什么 |
| 处理 | 写进 `ASSUMPTIONS`，带 `probe`，随结论一起输出 | 写进风险清单，**不产出结论**，或产出时明确标"待验证" |
| 例子 | H1 ceil、H4 闸门口径 | 有赞真实接口路径/字段（无账号）、当前线上取整 |

---

## 5. 撤回机制（继承 v1 的 `withdrawn` 做法）

任何假设/结论被新证据推翻时：
1. **不删历史**：在 `docs/00-migration.md` 与 `ASSUMPTIONS` 里保留条目，标注 `superseded by …`；
2. **单测跟着改**：改口径必须同时改回归用例（例如若证明是 round 而非 ceil，`tolerance` 用例要重写并注明依据）；
3. **审计留痕**：模型/工具输出的历史结论不追改，只在新结论里标注「口径已变更」。

> 这条纪律来自 v1 的一个正面做法：它发现误读取整后，用 `update_unknown(expected_revision, status=resolved, disposition=withdrawn)`
> 留了不可篡改的修订痕迹，而不是"删掉重写"。
