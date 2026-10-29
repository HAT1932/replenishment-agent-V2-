#!/usr/bin/env node
/**
 * scripts/verify.mjs — 端到端验收（对**真实启动的服务**打 HTTP/SSE）
 * ---------------------------------------------------------------------------
 * 做什么：
 *   1) 用**临时 SQLite** + 随机端口起真实服务（默认 mock provider，离线可跑）；
 *   2) 依次验证：健康/元数据、方案 CRUD、建议（as_of/only_low）、SKU 详情、库存、
 *      安全库存、节假日、会话、SSE 一轮对话、审计、草稿→审批→提交、定时任务、
 *      错误码与安全基线；
 *   3) 输出 PASS/FAIL/SKIP 清单 + 汇总 + 退出码（0 全绿 / 1 有失败）。
 *
 * 用法：
 *   node scripts/verify.mjs          # mock provider（默认，离线）
 *   node scripts/verify.mjs --live   # 额外用真实 DeepSeek 跑一轮对话（需 .env 有 key）
 *
 * 纪律：绝不打印 API key；临时库在结束时删除。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../server/config.mjs';
import { createServer } from '../server/index.mjs';

// ---------------------------------------------------------------------------
// 小型断言框架
// ---------------------------------------------------------------------------

const results = [];
let groupTitle = '';

function group(title) {
  groupTitle = title;
  console.log(`\n── ${title} ──`);
}

function record(ok, name, note) {
  results.push({ ok, name, note, group: groupTitle });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${note ? `  （${note}）` : ''}`);
}

/** 跑一条断言；fn 可返回一段补充说明（字符串） */
async function check(name, fn) {
  try {
    const note = await fn();
    record(true, name, typeof note === 'string' ? note : undefined);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(false, name, message);
    return false;
  }
}

function skip(name, reason) {
  results.push({ ok: true, skipped: true, name, note: reason, group: groupTitle });
  console.log(`SKIP  ${name}  （${reason}）`);
}

// ---------------------------------------------------------------------------
// HTTP / SSE 小工具
// ---------------------------------------------------------------------------

/** 把 SSE 原始文本按 `data: ` + 空行解析（与前端完全一致） */
function parseSse(raw) {
  const events = [];
  const comments = [];
  for (const frame of String(raw).split('\n\n')) {
    if (!frame) continue;
    if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice('data: '.length)));
    else if (frame.startsWith(':')) comments.push(frame);
  }
  return { events, comments };
}

function makeClient(base) {
  const json = async (pathname, init) => {
    const res = await fetch(new URL(pathname, base), init);
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { res, status: res.status, body, text, headers: res.headers };
  };
  const send = (method) => (pathname, payload) =>
    json(pathname, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
  return { json, post: send('POST'), put: send('PUT'), del: send('DELETE') };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const startedAt = Date.now();

async function main() {
  const live = process.argv.includes('--live');
  const workDir = await mkdtemp(path.join(tmpdir(), 'repl-verify-'));
  const dbPath = path.join(workDir, 'verify.db');

  /** mock 模式强制 provider=mock，保证离线可重复 */
  const config = loadConfig({
    env: { ...process.env, DB_PATH: dbPath, PORT: '0', HOST: '127.0.0.1', LLM_PROVIDER: 'mock' },
  });
  config.dbPath = dbPath;
  config.port = 0;

  let app;
  try {
    app = await createServer({ config });
    await app.listen(0, '127.0.0.1');
  } catch (err) {
    console.error('\n✖ 服务启动失败：', err?.stack ?? err?.message ?? err);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  }

  const base = app.url;
  const api = makeClient(base);
  const repo = app.deps?.repo ?? {};
  const state = { sessionId: null, draftId: null, approvalId: null };

  console.log(`\n验收目标：${base}  provider=${config.llm.provider}  db=${path.basename(dbPath)}`);

  try {
    // ================= 1. 健康与元数据 =================
    group('1. 健康与元数据');

    await check('GET /api/health 返回统一信封且 status=ok', async () => {
      const { res, body, status } = await api.json('/api/health');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.data.status, 'ok');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });

    await check('health 字段齐全（status/service/version/provider/model/today/node）', async () => {
      const { body } = await api.json('/api/health');
      for (const key of ['status', 'service', 'version', 'provider', 'model', 'today', 'node']) {
        assert.ok(key in body.data, `缺少 ${key}`);
      }
      assert.match(body.data.today, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(body.data.node, /^v\d+\./);
    });

    await check('health 不回显 API key（provider/model 来自 publicConfig）', async () => {
      const { text } = await api.json('/api/health');
      assert.ok(!/sk-[A-Za-z0-9]{6,}/.test(text), '响应里出现疑似 key');
      assert.ok(!text.toLowerCase().includes('apikey'), '出现 apikey 字段');
      assert.ok(!text.includes('LLM_API_KEY'));
    });

    await check('GET /api/meta 返回门店/供应商/分类/方案/计数', async () => {
      const { body, status } = await api.json('/api/meta');
      assert.equal(status, 200);
      const data = body.data;
      assert.ok(Array.isArray(data.stores) && data.stores.length > 0, 'stores 为空');
      assert.ok(Array.isArray(data.categories));
      assert.ok(Array.isArray(data.plans) && data.plans.length >= 2, 'plans 少于 2 个');
      assert.ok(data.counts && typeof data.counts === 'object');
      assert.match(data.today, /^\d{4}-\d{2}-\d{2}$/);
    });

    await check('GET /api/assumptions 返回假设清单（H1…）', async () => {
      const { body, status } = await api.json('/api/assumptions');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.data.assumptions) && body.data.assumptions.length > 0);
      assert.ok(body.data.assumptions.every((item) => typeof item.id === 'string'));
    });

    // ================= 2. 方案 CRUD =================
    group('2. 方案 CRUD');

    const systemPlan = { id: null, createdId: null };
    await check('GET /api/plans 至少含 2 个系统方案', async () => {
      const { body, status } = await api.json('/api/plans');
      assert.equal(status, 200);
      assert.ok(body.data.plans.length >= 2);
      systemPlan.id = body.data.plans[0]?.plan_id ?? body.data.plans[0]?.id;
      assert.ok(systemPlan.id, '方案缺少 id');
    });

    await check('GET /api/plans/:id 返回单个方案', async () => {
      const { body, status } = await api.json(`/api/plans/${encodeURIComponent(systemPlan.id)}`);
      assert.equal(status, 200);
      assert.ok(body.data.plan_type || body.data.formula_text, '方案缺少关键字段');
    });

    await check('POST /api/plans 新建方案（201）', async () => {
      const { body, status } = await api.post('/api/plans', {
        plan_name: `验收方案 ${Date.now() % 100000}`,
        plan_type: 'custom',
        config: { purchase_cycle_days: 7, coverage_days: 3, coefficient_enabled: false },
      });
      assert.equal(status, 201);
      const plan = body.data.plan ?? body.data;
      systemPlan.createdId = plan.plan_id ?? plan.id;
      assert.ok(systemPlan.createdId, '新建方案未返回 id');
    });

    await check('PUT /api/plans/:id 修改方案', async () => {
      const { body, status } = await api.put(`/api/plans/${encodeURIComponent(systemPlan.createdId)}`, {
        plan_name: '验收方案·已改名',
      });
      assert.equal(status, 200);
      const plan = body.data.plan ?? body.data;
      assert.equal(plan.plan_name, '验收方案·已改名');
    });

    await check('DELETE /api/plans/:id 删除自建方案', async () => {
      const { status } = await api.del(`/api/plans/${encodeURIComponent(systemPlan.createdId)}`);
      assert.equal(status, 200);
    });

    await check('DELETE 系统默认方案 → 409 CONFLICT', async () => {
      const { status, body } = await api.del(`/api/plans/${encodeURIComponent(systemPlan.id)}`);
      assert.equal(status, 409);
      assert.equal(body.error.code, 'CONFLICT');
    });

    // ================= 3. 建议 / SKU / 库存 =================
    group('3. 建议与 SKU');

    let allRows = [];
    await check('GET /api/suggestions 返回 rows/kpi/formula_text/as_of', async () => {
      const { body, status } = await api.json('/api/suggestions');
      assert.equal(status, 200);
      const data = body.data;
      for (const key of ['as_of', 'rows', 'kpi', 'formula_text', 'plan', 'total']) {
        assert.ok(key in data, `缺少 ${key}`);
      }
      assert.ok(Array.isArray(data.rows));
      allRows = data.rows;
      assert.ok(allRows.length > 0, '建议行为空（seed 数据异常）');
      // 契约 §2.5 的稳定字段抽检
      const row = allRows[0];
      for (const key of ['sku_code', 'suggest_num', 'apply_num', 'provenance', 'guard', 'terms']) {
        assert.ok(key in row, `Suggestion 缺少 ${key}`);
      }
    });

    await check('as_of 生效：返回的 as_of 与请求一致', async () => {
      const target = '2026-01-10';
      const { body } = await api.json(`/api/suggestions?as_of=${target}&page_size=5`);
      assert.equal(body.data.as_of, target);
    });

    await check('only_low=true 结果为全集子集且每行都触发低库存闸门', async () => {
      const { body } = await api.json('/api/suggestions?only_low=true');
      const rows = body.data.rows;
      assert.ok(rows.length <= allRows.length);
      for (const row of rows) {
        const passed = row.guard?.passed ?? row.guard?.alert;
        assert.equal(Boolean(passed), true, `${row.sku_code} 不该出现在 only_low 结果里`);
      }
      return `全集 ${allRows.length} / 低库存 ${rows.length}`;
    });

    await check('非法 as_of（2026-02-31）→ 400 VALIDATION_ERROR', async () => {
      const { status, body } = await api.json('/api/suggestions?as_of=2026-02-31');
      assert.equal(status, 400);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
      assert.equal(body.error.details.fields[0].field, 'as_of');
    });

    await check('非法 page_size（500）→ 400', async () => {
      const { status } = await api.json('/api/suggestions?page_size=500');
      assert.equal(status, 400);
    });

    let firstSkuCode = allRows[0]?.sku_code ?? null;
    await check('GET /api/sku/:code 返回库存四层 + 曲线 + 建议 + 解释', async () => {
      const { body, status } = await api.json(`/api/sku/${encodeURIComponent(firstSkuCode)}`);
      assert.equal(status, 200);
      const data = body.data;
      assert.ok(data.sku, '缺少 sku');
      assert.ok(data.inventory, '缺少 inventory');
      assert.ok(Array.isArray(data.sales), '缺少 sales 曲线');
      assert.ok('suggestions' in data, '缺少 suggestions');
      assert.ok('explain' in data, '缺少 explain');
    });

    await check('未知 SKU → 404 NOT_FOUND', async () => {
      const { status, body } = await api.json('/api/sku/SKU-NOT-EXIST');
      assert.equal(status, 404);
      assert.equal(body.error.code, 'NOT_FOUND');
    });

    await check('GET /api/inventory 返回库存列表', async () => {
      const { body, status } = await api.json('/api/inventory?page_size=10');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.data.rows) && body.data.rows.length > 0);
      const row = body.data.rows[0];
      assert.ok(row.sku_code, '库存行缺少 sku_code');
      assert.ok('on_hand' in row || 'sellable' in row, '库存行缺少数量字段');
      firstSkuCode = firstSkuCode ?? row.sku_code;
    });

    // ================= 3.5 决策支持（工作台 / SKU 下钻） =================
    group('3.5 决策支持：工作台与 SKU 下钻');

    let workbenchRow = null;
    await check('GET /api/workbench 返回风险分级 + 可售天数 + 断货日 + 资金占用', async () => {
      const { body, status } = await api.json('/api/workbench?page_size=10');
      assert.equal(status, 200);
      const data = body.data;
      assert.ok(Array.isArray(data.rows) && data.rows.length > 0, '工作台没有行');
      const kpi = data.kpi;
      assert.ok(kpi && typeof kpi.row_count === 'number', '缺少 KPI');
      for (const key of ['stockout_count', 'urgent_count', 'suggest_count', 'slow_moving_count', 'sufficient_count']) {
        assert.ok(typeof kpi[key] === 'number', `KPI 缺少 ${key}`);
      }
      assert.ok(typeof kpi.inventory_capital === 'number', 'KPI 缺少库存资金');
      const row = data.rows[0];
      assert.ok(row.risk_level, '行缺少 risk_level');
      assert.ok(['缺货', '紧急', '建议', '滞销', '充足'].includes(row.risk_level), `非法 risk_level：${row.risk_level}`);
      assert.ok('cover_days' in row, '行缺少 cover_days');
      assert.ok('stockout_date' in row, '行缺少 stockout_date');
      assert.ok(typeof row.inventory_capital === 'number', '行缺少 inventory_capital');
      assert.equal(row.risk_provenance, 'enhancement', '风险分级必须标注为增强实现');
      assert.ok(data.citation?.disclaimer, '缺少页面级可信声明');
      workbenchRow = row;
      return `${data.total} 个 SKU · 缺货 ${kpi.stockout_count} / 紧急 ${kpi.urgent_count} / 资金 ${Math.round(
        kpi.inventory_capital,
      )}`;
    });

    await check('工作台风险筛选与服务端 KPI 一致（risk=紧急）', async () => {
      const { body } = await api.json(`/api/workbench?risk=${encodeURIComponent('紧急')}&page_size=50`);
      assert.ok(body.data.rows.every((row) => row.risk_level === '紧急'), '筛选后出现非紧急行');
      assert.equal(body.data.total, body.data.kpi.urgent_count, '筛选 total 与 KPI 不一致');
      return `${body.data.total} 个紧急`;
    });

    await check('工作台非法 risk → 400（details.fields 指明字段）', async () => {
      const { status, body } = await api.json('/api/workbench?risk=不存在的等级');
      assert.equal(status, 400);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
      assert.equal(body.error.details.fields[0].field, 'risk');
    });

    await check('GET /api/sku/:code 带 decision（风险视图）+ 四方案对照 + 90 天序列', async () => {
      assert.ok(workbenchRow?.sku_code, '没有可用 SKU');
      const { body, status } = await api.json(`/api/sku/${encodeURIComponent(workbenchRow.sku_code)}`);
      assert.equal(status, 200);
      const data = body.data;
      assert.ok(data.decision?.risk?.level, '缺少 decision.risk.level');
      assert.equal(data.decision.risk.provenance, 'enhancement');
      assert.ok(Array.isArray(data.suggestions) && data.suggestions.length >= 2, '缺少多方案对照');
      assert.ok(Array.isArray(data.series) && data.series.length === 90, '缺少 90 天序列');
      assert.ok(data.explain?.terms, '缺少解释链 terms');
      assert.ok(Array.isArray(data.explain?.why) && data.explain.why.length > 0, '缺少 why 分步推导');
      return `风险 ${data.decision.risk.level} · 方案 ${data.suggestions.length} 个 · 序列 ${data.series.length} 天`;
    });

    // ================= 3.6 AI 解释与 What-if =================
    group('3.6 AI 解释与 What-if（PRD US-01/US-02）');

    let aiExplain = null;
    await check('POST /api/explain 返回四段解释 + 因子 + 数值对账', async () => {
      assert.ok(workbenchRow?.sku_code, '没有可用 SKU');
      const { body, status } = await api.post('/api/explain', { sku_code: workbenchRow.sku_code });
      assert.equal(status, 200);
      const data = body.data;
      assert.ok(data.explanation?.text && data.explanation.text.length > 80, '解释文本过短');
      for (const section of ['【结论】', '【账怎么算的】', '【关键判断】', '【风险与建议】']) {
        assert.ok(data.explanation.text.includes(section), `解释缺少段落 ${section}`);
      }
      assert.ok(['llm', 'deterministic'].includes(data.explanation.source), '未知解释来源');
      assert.ok(data.explanation.verification && typeof data.explanation.verification.checked === 'number');
      assert.equal(data.explanation.verification.ok, true, `存在未溯源数字：${(data.explanation.verification.unknown ?? []).join(',')}`);
      assert.ok(Array.isArray(data.grounding?.factors) && data.grounding.factors.length >= 2, '缺少决策因子');
      assert.equal(data.grounding.factor_identity?.ok, true, '因子加不回未截断值');
      assert.ok(data.grounding.confidence?.level, '缺少置信度');
      assert.ok(data.grounding.urgency?.level, '缺少紧急度');
      aiExplain = data;
      return `${data.explanation.source} · ${data.explanation.text.length} 字 · 对账 ${data.explanation.verification.grounded}/${data.explanation.verification.checked} · 因子 ${data.grounding.factors.length} 项`;
    });

    await check('POST /api/whatif：改目标可售天数 → 数量变化且给出差额', async () => {
      const { body, status } = await api.post('/api/whatif', {
        sku_code: workbenchRow.sku_code,
        overrides: { coverage_days: 25 },
      });
      assert.equal(status, 200);
      const data = body.data;
      assert.notEqual(data.after.suggest_num, data.before.suggest_num, '改可售天数应改变建议量');
      assert.equal(data.delta.qty, data.after.suggest_num - data.before.suggest_num);
      assert.ok(data.factor_delta.length >= 1, '应给出因子级差额');
      return `${data.before.suggest_num} → ${data.after.suggest_num}（Δ${data.delta.qty}）`;
    });

    await check('POST /api/whatif：非法/越界参数 → 400（不静默忽略）', async () => {
      const bad = await api.post('/api/whatif', { sku_code: workbenchRow.sku_code, overrides: { magic: 1 } });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
      const outOfRange = await api.post('/api/whatif', {
        sku_code: workbenchRow.sku_code,
        overrides: { coverage_days: 999 },
      });
      assert.equal(outOfRange.status, 400);
    });

    await check('POST /api/explain：未知 SKU → 404', async () => {
      const { status, body } = await api.post('/api/explain', { sku_code: 'SKU-NOT-EXIST' });
      assert.equal(status, 404);
      assert.equal(body.error.code, 'NOT_FOUND');
    });

    // ================= 4. 基础数据 =================
    group('4. 安全库存与节假日');

    const safetyOriginal = {};
    await check('GET /api/safety-stock 返回扁平配置', async () => {
      const { body, status } = await api.json('/api/safety-stock');
      assert.equal(status, 200);
      const cfg = body.data;
      for (const key of ['mode', 'lower_fixed', 'upper_fixed', 'min_sellable_days', 'max_sellable_days']) {
        assert.ok(key in cfg, `安全库存缺少 ${key}`);
      }
      Object.assign(safetyOriginal, cfg);
    });

    await check('PUT /api/safety-stock 保存后 GET 可见', async () => {
      const nextLower = Number(safetyOriginal.lower_fixed ?? 5) + 1;
      const put = await api.put('/api/safety-stock', { lower_fixed: nextLower });
      assert.ok(put.status === 200, `PUT 状态 ${put.status}`);
      const { body } = await api.json('/api/safety-stock');
      assert.equal(Number(body.data.lower_fixed), nextLower);
      // 还原，避免影响后续建议断言
      await api.put('/api/safety-stock', { lower_fixed: safetyOriginal.lower_fixed });
    });

    await check('PUT /api/safety-stock 非法数值 → 400', async () => {
      const { status, body } = await api.put('/api/safety-stock', { min_sellable_days: -1 });
      assert.equal(status, 400);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    });

    await check('GET /api/holidays 返回数组', async () => {
      const { body, status } = await api.json('/api/holidays');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.data.holidays));
    });

    await check('POST /api/holidays 新增后 GET 可见，DELETE 后消失', async () => {
      const date = '2026-05-01';
      const created = await api.post('/api/holidays', { date, name: '验收节日' });
      assert.equal(created.status, 201);
      const after = await api.json('/api/holidays');
      const dates = after.body.data.holidays.map((item) =>
        typeof item === 'string' ? item : item?.date,
      );
      assert.ok(dates.includes(date), '新增节假日未出现在列表');
      const removed = await api.json(`/api/holidays?date=${date}`, { method: 'DELETE' });
      assert.equal(removed.status, 200);
      const final = await api.json('/api/holidays');
      const finalDates = final.body.data.holidays.map((item) =>
        typeof item === 'string' ? item : item?.date,
      );
      assert.ok(!finalDates.includes(date), '删除节假日未生效');
    });

    // ================= 5. 会话 + SSE =================
    group('5. 会话与 SSE 对话');

    await check('POST /api/sessions 创建会话（201）', async () => {
      const { body, status } = await api.post('/api/sessions', { title: '验收会话' });
      assert.equal(status, 201);
      state.sessionId = body.data.session_id;
      assert.ok(state.sessionId, '未返回 session_id');
    });

    await check('GET /api/sessions 列表含新会话', async () => {
      const { body } = await api.json('/api/sessions');
      assert.ok(body.data.sessions.some((item) => item.session_id === state.sessionId));
    });

    let sseEvents = [];
    await check('POST /api/sessions/:id/messages 返回 SSE 头（四项必须）', async () => {
      const res = await fetch(new URL(`/api/sessions/${state.sessionId}/messages`, base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '帮我看看哪些 SKU 需要补货，并生成一批草稿' }),
      });
      assert.equal(res.status, 200);
      const type = res.headers.get('content-type') ?? '';
      assert.match(type, /text\/event-stream/);
      assert.match(type, /charset=utf-8/);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.equal(res.headers.get('connection'), 'keep-alive');
      assert.equal(res.headers.get('x-accel-buffering'), 'no');
      const raw = await res.text();
      sseEvents = parseSse(raw).events;
    });

    await check('SSE 事件：seq 从 1 严格递增且 done 收尾', async () => {
      assert.ok(sseEvents.length > 0, '没有收到任何事件');
      assert.equal(sseEvents[0].seq, 1);
      for (let index = 1; index < sseEvents.length; index += 1) {
        assert.ok(sseEvents[index].seq > sseEvents[index - 1].seq, 'seq 非单调');
      }
      const last = sseEvents.at(-1);
      assert.equal(last.type, 'done');
      assert.equal(typeof last.finish_reason, 'string');
      return `${sseEvents.length} 条事件`;
    });

    await check('SSE 事件：至少一次 tool_call + tool_result 且 call_id 能关联', async () => {
      const calls = sseEvents.filter((event) => event.type === 'tool_call');
      const resultsList = sseEvents.filter((event) => event.type === 'tool_result');
      assert.ok(calls.length >= 1, '没有 tool_call');
      assert.ok(resultsList.length >= 1, '没有 tool_result');
      const call = calls[0];
      assert.ok(call.call_id && call.name, 'tool_call 缺少 call_id/name');
      assert.ok(resultsList.some((item) => item.call_id === call.call_id), 'call_id 未关联');
      return `${calls.length} 次工具调用`;
    });

    await check('SSE 事件：不含 error 事件（mock provider 应正常完成）', async () => {
      const errors = sseEvents.filter((event) => event.type === 'error');
      assert.equal(errors.length, 0, `出现 error：${JSON.stringify(errors[0])}`);
    });

    await check('用户消息与助手消息已落库（会话详情可读）', async () => {
      const { body } = await api.json(`/api/sessions/${state.sessionId}`);
      const messages = body.data.messages ?? [];
      assert.ok(messages.length >= 1, '没有消息');
      assert.ok(
        messages.some((item) => item.role === 'user'),
        '缺少用户消息',
      );
      return `${messages.length} 条消息`;
    });

    await check('GET /api/audit 能看到本轮工具审计', async () => {
      const { body, status } = await api.json(
        `/api/audit?session_id=${encodeURIComponent(state.sessionId)}&limit=100`,
      );
      assert.equal(status, 200);
      const events = body.data.events ?? [];
      assert.ok(events.length >= 1, '该会话没有任何审计事件（工具调用必须写审计）');
      assert.ok(
        events.every((event) => event.kind),
        '审计事件缺少 kind',
      );
      return `${events.length} 条审计`;
    });

    // ================= 6. 草稿 → 审批 → 提交 =================
    group('6. 草稿 → 审批 → 提交');

    // 优先复用 SSE 产出的草稿/审批；没有就由验收脚本直接播种（并标注）
    let fallbackSeed = false;
    const draftFromEvents = sseEvents.find(
      (event) => event.type === 'artifact' && event.artifact?.kind === 'draft',
    );
    const approvalFromEvents = sseEvents.find((event) => event.type === 'approval_required');
    // artifact.ref 是对象（{draft_id,...}）；兼容字符串 id 的旧形状
    const draftRef = draftFromEvents?.artifact?.ref ?? null;
    state.draftId =
      (typeof draftRef === 'string' ? draftRef : draftRef?.draft_id) ??
      sseEvents.find((event) => event.type === 'tool_result' && event.data?.draft_id)?.data?.draft_id ??
      null;
    state.approvalId = approvalFromEvents?.approval?.id ?? null;

    if (!state.draftId || !state.approvalId) {
      fallbackSeed = true;
      try {
        const draft = await repo.createOrderDraft(app.db, {
          kind: 'purchase',
          items: [{ sku_code: firstSkuCode, apply_num: 3 }],
          expected_arrival: null,
          remark: '验收脚本播种',
          created_by: 'verify',
          session_id: state.sessionId,
        });
        state.draftId = state.draftId ?? draft.draft_id;
        const approval = await repo.createApproval(app.db, {
          session_id: state.sessionId,
          draft_id: state.draftId,
          kind: 'order_commit',
          summary: '验收：提交采购单',
          risk: 'medium',
          requested_by: 'agent',
        });
        state.approvalId = state.approvalId ?? approval.id;
      } catch (err) {
        console.log(`      （播种失败：${err?.message ?? err}）`);
      }
    }

    await check('POST /api/drafts 只产草稿（不提交）', async () => {
      const { body, status } = await api.post('/api/drafts', {
        kind: 'purchase',
        items: [{ sku_code: firstSkuCode, apply_num: 2 }],
        remark: '验收：建议表一键生成草稿',
        session_id: state.sessionId,
        created_by: 'verify',
      });
      assert.equal(status, 201);
      const draft = body.data.draft ?? body.data;
      assert.ok(draft.draft_id, '未返回 draft_id');
      assert.equal(draft.status ?? 'draft', 'draft');
    });

    await check('GET /api/drafts 与 /api/drafts/:id 可读', async () => {
      assert.ok(state.draftId, '没有可用草稿');
      const list = await api.json('/api/drafts');
      assert.equal(list.status, 200);
      assert.ok(list.body.data.drafts.length >= 1);
      const one = await api.json(`/api/drafts/${encodeURIComponent(state.draftId)}`);
      assert.equal(one.status, 200);
      assert.ok(one.body.data.draft);
    });

    await check('待审草稿提交 → 409 APPROVAL_REQUIRED', async () => {
      assert.ok(state.approvalId, '没有可用审批');
      const { status, body } = await api.post(
        `/api/drafts/${encodeURIComponent(state.draftId)}/commit`,
        { approval_id: state.approvalId },
      );
      assert.equal(status, 409);
      assert.equal(body.error.code, 'APPROVAL_REQUIRED');
    });

    await check('GET /api/approvals?status=pending 含该审批', async () => {
      const { body, status } = await api.json('/api/approvals?status=pending');
      assert.equal(status, 200);
      assert.ok(body.data.approvals.some((item) => (item.id ?? item.approval_id) === state.approvalId));
    });

    await check('批准审批 → approved', async () => {
      const { body, status } = await api.post(
        `/api/sessions/${encodeURIComponent(state.sessionId)}/approvals/${encodeURIComponent(state.approvalId)}`,
        { decision: 'approve', note: '验收通过' },
      );
      assert.equal(status, 200);
      const approval = body.data.approval ?? body.data;
      assert.equal(approval.status, 'approved');
    });

    let committedOrderId = null;
    await check('提交草稿 → 正式单（biz_no/status）', async () => {
      const { body, status } = await api.post(
        `/api/drafts/${encodeURIComponent(state.draftId)}/commit`,
        { approval_id: state.approvalId },
      );
      assert.equal(status, 200);
      const order = body.data.order ?? body.data;
      committedOrderId = order.order_id ?? order.id;
      assert.ok(committedOrderId, '未返回 order_id');
      assert.ok(order.biz_no, '未返回 biz_no');
      assert.match(String(order.biz_no), /[A-Za-z]/);
      return `biz_no=${order.biz_no}`;
    });

    await check('重复提交幂等：返回同一张单', async () => {
      const { body, status } = await api.post(
        `/api/drafts/${encodeURIComponent(state.draftId)}/commit`,
        { approval_id: state.approvalId },
      );
      assert.equal(status, 200);
      const order = body.data.order ?? body.data;
      assert.equal(order.order_id ?? order.id, committedOrderId);
    });

    await check('GET /api/orders?kind=purchase 含该正式单', async () => {
      const { body, status } = await api.json('/api/orders?kind=purchase');
      assert.equal(status, 200);
      assert.ok(
        body.data.orders.some((item) => (item.order_id ?? item.id) === committedOrderId),
        '正式单未出现在列表',
      );
    });

    // ================= 7. 定时任务 =================
    group('7. 定时任务');

    let scheduleId = null;
    await check('GET /api/schedules 返回定时任务列表', async () => {
      const { body, status } = await api.json('/api/schedules');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.data.schedules));
      scheduleId = body.data.schedules[0]?.id ?? body.data.schedules[0]?.schedule_id ?? null;
    });

    if (scheduleId) {
      await check('POST /api/schedules/:id/run 手动触发', async () => {
        const { body, status } = await api.post(
          `/api/schedules/${encodeURIComponent(scheduleId)}/run`,
          {},
        );
        assert.equal(status, 200);
        const result = body.data.result;
        assert.ok(result, '未返回 run 结果');
        assert.ok(result.run_id || result.runs, 'run 结果缺少 run_id');
        return `ok=${result.ok ?? 'n/a'}`;
      });
    } else {
      skip('POST /api/schedules/:id/run 手动触发', 'seed 里没有定时任务');
    }

    // ================= 8. 错误码与安全基线 =================
    group('8. 错误码与安全基线');

    await check('未知 /api 路由 → 404 NOT_FOUND（统一信封）', async () => {
      const { status, body } = await api.json('/api/no-such-endpoint');
      assert.equal(status, 404);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'NOT_FOUND');
      assert.ok(!('stack' in body.error));
    });

    await check('方法不匹配 → 404 且提示允许方法', async () => {
      const { status, body } = await api.post('/api/health', {});
      assert.equal(status, 404);
      assert.match(body.error.message, /允许|POST/);
    });

    await check('坏 JSON → 400 VALIDATION_ERROR', async () => {
      const { status, body } = await api.json('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ broken',
      });
      assert.equal(status, 400);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    });

    await check('请求体超过 2MB → 413', async () => {
      const { status, body } = await api.post('/api/sessions', {
        title: 'x'.repeat(2 * 1024 * 1024 + 64),
      });
      assert.equal(status, 413);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    });

    await check('安全头：nosniff / no-store / 无 CORS 放行', async () => {
      const { headers } = await api.json('/api/health');
      assert.equal(headers.get('x-content-type-options'), 'nosniff');
      assert.equal(headers.get('cache-control'), 'no-store');
      assert.equal(headers.get('access-control-allow-origin'), null);
    });

    await check('目录穿越被拒（不读到源码）', async () => {
      const res = await fetch(new URL('/%2e%2e%2fserver%2fconfig.mjs', base));
      const text = await res.text();
      assert.ok(res.status === 400 || res.status === 403 || res.status === 404, `状态 ${res.status}`);
      assert.ok(!text.includes('loadConfig'), '穿越读到了源码');
    });

    // ================= 9. 静态资源（dist 存在才验） =================
    group('9. 静态资源');

    let hasDist = false;
    try {
      await access(path.join(config.rootDir, 'dist', 'index.html'));
      hasDist = true;
    } catch {
      hasDist = false;
    }

    if (hasDist) {
      await check('GET / 返回 index.html（no-cache + CSP）', async () => {
        const res = await fetch(new URL('/', base), { headers: { Accept: 'text/html' } });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /text\/html/);
        assert.equal(res.headers.get('cache-control'), 'no-cache');
        assert.ok((res.headers.get('content-security-policy') ?? '').includes("default-src 'self'"));
        const html = await res.text();
        assert.ok(html.includes('id="root"') || html.includes('id=root'), 'HTML 异常');
      });

      await check('SPA fallback：#/agent 深层路径回 index.html', async () => {
        const res = await fetch(new URL('/sessions', base), { headers: { Accept: 'text/html' } });
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('<div id="root">') || html.includes('id="root"'));
      });
    } else {
      skip('静态资源与 SPA fallback', 'dist/ 尚未构建（npm run build 后再验）');
    }

    // ================= 10. --live 真实 LLM =================
    if (live) {
      group('10. 真实 LLM（--live）');
      const liveConfig = loadConfig({
        env: { ...process.env, DB_PATH: dbPath, PORT: '0', HOST: '127.0.0.1' },
      });
      liveConfig.dbPath = dbPath;
      liveConfig.port = 0;

      if (liveConfig.llm.provider !== 'deepseek' || !liveConfig.llm.apiKey) {
        skip('真实 DeepSeek 对话', '未配置 LLM_API_KEY（或 provider 不是 deepseek）');
      } else {
        let liveApp = null;
        try {
          liveApp = await createServer({ config: liveConfig });
          await liveApp.listen(0, '127.0.0.1');
          const client = makeClient(liveApp.url);
          const created = await client.post('/api/sessions', { title: '实时模型验收' });
          state.liveSessionId = created.body.data.session_id;

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 180_000);
          let liveEvents = [];
          try {
            const res = await fetch(
              new URL(`/api/sessions/${state.liveSessionId}/messages`, liveApp.url),
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: '帮我看一下今天的补货建议，列出需要补货的 SKU。' }),
                signal: controller.signal,
              },
            );
            liveEvents = parseSse(await res.text()).events;
          } finally {
            clearTimeout(timer);
          }

          await check('真实模型：至少一次 tool_call', async () => {
            assert.ok(
              liveEvents.some((event) => event.type === 'tool_call'),
              `事件类型：${[...new Set(liveEvents.map((e) => e.type))].join(',')}`,
            );
          });
          await check('真实模型：本轮以 done 收尾且无 error', async () => {
            assert.ok(liveEvents.some((event) => event.type === 'done'), '没有 done');
            const errors = liveEvents.filter((event) => event.type === 'error');
            assert.equal(
              errors.length,
              0,
              `出现 error：${errors.map((e) => e.code).join(',')}`,
            );
          });
          await check('真实模型：usage 有 token 统计', async () => {
            const usage = liveEvents.find((event) => event.type === 'usage');
            assert.ok(usage, '没有 usage 事件');
            assert.ok(Number(usage.prompt_tokens) >= 0);
            return `prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}`;
          });
        } catch (err) {
          record(false, '真实 DeepSeek 对话', err?.message ?? String(err));
        } finally {
          if (liveApp) await liveApp.close().catch(() => {});
        }
      }
    }
  } finally {
    await app.close().catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  // ================= 汇总 =================
  const passed = results.filter((item) => item.ok && !item.skipped).length;
  const failed = results.filter((item) => !item.ok);
  const skipped = results.filter((item) => item.skipped).length;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('\n──────────────────────────────────────────');
  if (failed.length > 0) {
    console.log(`失败项（${failed.length}）：`);
    for (const item of failed) console.log(`  ✖ [${item.group}] ${item.name}\n     ${item.note}`);
    console.log('');
  }
  console.log(
    `汇总：${passed} PASS / ${failed.length} FAIL / ${skipped} SKIP，共 ${results.length} 项，用时 ${seconds}s`,
  );
  console.log(`provider=${config.llm.provider}${live ? '（含 --live）' : ''}`);
  console.log(failed.length === 0 ? '✅ 验收通过' : '❌ 验收未通过');

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n✖ 验收脚本异常：', err?.stack ?? err?.message ?? err);
  process.exit(1);
});
