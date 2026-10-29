# 04 · 运行手册（Runbook）

## 1. 环境要求

- Node.js **≥ 22.5**（使用内置 `node:sqlite`，无原生编译）
- 首次需要 `npm install`（只装前端构建依赖；服务端零第三方依赖）
- 可选：`LLM_API_KEY`（没有就自动降级为 mock provider，全流程仍可跑通）

## 2. 三种跑法

### A. 生产模式（单端口，推荐验收用）

```bash
cp .env.example .env      # 填 LLM_API_KEY（可留空 → mock）
npm install
npm run build             # 产物在 dist/
npm start                 # → http://127.0.0.1:3200
```

### B. 开发模式（前端热更新）

```bash
npm run dev               # 后端 3200
npm run dev:web           # 前端 5273，/api 代理到 3200
# 打开 http://127.0.0.1:5273
```

### C. 纯离线（无 key）

`.env` 里 `LLM_PROVIDER=mock`（或留空 key），`mock` provider 用确定性脚本回放同样的 SSE 事件，
用于 CI/演示/教学。

## 3. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3200` / `127.0.0.1` | 服务端口 |
| `DB_PATH` | `data/agent.db` | SQLite 路径；`:memory:` 可用于测试 |
| `LLM_PROVIDER` | `deepseek` | `deepseek` / `mock` |
| `LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容端点 |
| `LLM_MODEL` | `deepseek-flash` | 实测可用（DeepSeek-V4.1-Flash，1M ctx） |
| `LLM_API_KEY` | — | 为空 → 自动降级 mock，并在 `/api/health.degraded_reason` 说明 |
| `AGENT_MAX_STEPS` | `8` | 单轮最大步数 |
| `AGENT_MAX_TOOL_CALLS` | `12` | 单轮最大工具调用数 |
| `AGENT_TURN_BUDGET_MS` | `180000` | 单轮总预算 |
| `AGENT_TOOL_TIMEOUT_MS` | `20000` | 单工具超时 |

> key 只存在 `.env`（已在 `.gitignore`）；服务端日志与接口输出均脱敏。

## 4. 验收（DoD）

```bash
npm test                    # 128 项：domain 32 / data 13 / agent 36 / api 41
node scripts/verify.mjs     # 50 项端到端（进程内起服务 + 临时库）
node scripts/verify.mjs --live   # 追加 3 项真实模型（tool_call / done / usage）
npm run typecheck           # tsc --noEmit（strict）
npm run build               # vite build
node scripts/live-e2e.mjs   # 一轮真实会话，打印工具时间线/artifacts/审计
node scripts/shots.mjs      # headless Chrome 截图 + 渲染断言（docs/screens/*.png）
```

预期：`128 pass`、`50 PASS`、`53 PASS（--live）`、`tsc exit 0`、`build ✓`。

## 5. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面白屏 / "后端连接失败" | 未 build 或后端未起 | `npm run build && npm start`；开发模式需同时跑 `dev` 与 `dev:web` |
| `/api/health` 显示 `degraded` | 数据层未就绪 | 看启动日志；删 `data/*.db` 重播种 |
| 对话报 `UPSTREAM_LLM_ERROR` | key 无效/额度/网络 | 检查 `.env`；或切 `LLM_PROVIDER=mock` 验证非模型链路 |
| SSE 没有流式效果 | 反向代理缓冲 | 响应头已带 `X-Accel-Buffering: no`；nginx 需 `proxy_buffering off` |
| 建议数量与手算差 1 件 | 取整假设 H1（ceil） | 属预期；见 `#/assumptions` |
| 某些 SKU 不出建议 | 闸门未通过（非低库存） | 界面有 `guard.text`；口径见 H4 |
| 播种数据与日期不匹配 | `meta.seed_end_date` 是数据日期 | 删库重启即可重新播种 |

## 6. 数据库维护

```bash
# 重建演示数据（必须先停服务，Windows 需先释放句柄）
npm run seed
# 备份
copy data\agent.db data\agent.db.bak
```

表结构与不变量见 `docs/01-architecture.md` §5。

## 7. 关键文件索引

| 位置 | 作用 |
|---|---|
| `server/domain/*.mjs` | 确定性内核（唯一算法出口，全量单测） |
| `server/data/queries.mjs` | 读模型：批量建议 + KPI + SKU 详情 |
| `server/agent/runtime.mjs` | Agent 循环/预算/审批闸门/事件流 |
| `server/agent/tools/*.mjs` | 14 个工具（只读 12 + 产草稿 2） |
| `server/http/router.mjs` | REST 路由 + SSE 入口 |
| `web/src/features/agent/*` | 会话 + 工具时间线 + 产物面板 |
| `docs/00-migration.md` | v1→v2 取/改/弃台账与回归用例 |
| `docs/03-assumptions.md` | H1–H10 假设与证伪方法 |

## 8. 上线前必须补的（当前明确未做）

1. **鉴权与多租户**（现在任何人可调 `/api/*`）；
2. **调度器的分布式互斥**（现在是进程内定时器）；
3. **数值对账校验器**（把模型输出里的数字与工具结果逐项比对，拦截幻觉）；
4. **SSE 断点续传**（`Last-Event-ID`）；
5. **真实数据管道**：商品/库存/出库明细的同步（有赞无补货建议开放接口，只能 RPA 或自建）。
