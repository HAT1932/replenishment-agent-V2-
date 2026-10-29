/**
 * shots.mjs — 起服务 + headless Chrome + CDP 截图（自证式：截图前先断言页面渲染出了关键元素）
 * 用法：node scripts/shots.mjs
 * 产出：docs/screens/*.png
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = path.resolve('docs/screens');
const PORT = Number(process.env.PORT || '3220');
const CDP_PORT = Number(process.env.CDP_PORT || '9333');

process.env.DB_PATH = process.env.DB_PATH || 'data/shots.db';
process.env.PORT = String(PORT);
// 复用已有会话截图时不能清库（否则会话/产物都没了）
if (!process.env.REUSE_SID) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(process.env.DB_PATH + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
}
mkdirSync(OUT_DIR, { recursive: true });

const { createServer } = await import('../server/index.mjs');
const app = await createServer();
await app.listen(PORT, '127.0.0.1');
console.log('server:', app.url);

const profile = mkdtempSync(path.join(tmpdir(), 'ra-chrome-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1600,1000',
    '--force-device-scale-factor=1',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCdp() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error('CDP 未就绪');
}

/** 极简 CDP 客户端（Node 24 自带 WebSocket） */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (message) => {
    const payload = JSON.parse(message.data);
    if (payload.id && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) reject(new Error(payload.error.message));
      else resolve(payload.result);
    } else if (payload.method) {
      events.push(payload);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', reject);
  });
  return {
    ws,
    events,
    ready,
    send(method, params = {}, sessionId) {
      seq += 1;
      const id = seq;
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      ws.close();
    },
  };
}

const browser = connect(await waitForCdp());
await browser.ready;

async function newPage() {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId);
  return { targetId, sessionId };
}

async function evalJs(sessionId, expression) {
  const result = await browser.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  return result?.result?.value;
}

async function goto(sessionId, url) {
  await browser.send('Page.navigate', { url }, sessionId);
  await sleep(300);
  for (let i = 0; i < 80; i += 1) {
    const state = await evalJs(sessionId, 'document.readyState');
    if (state === 'complete') break;
    await sleep(100);
  }
}

async function waitFor(sessionId, expression, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await evalJs(sessionId, `(() => { try { return Boolean(${expression}); } catch { return false; } })()`);
    if (ok) return;
    await sleep(120);
  }
  throw new Error(`等待超时：${label}（${expression}）`);
}

async function shot(sessionId, name) {
  const { data } = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  const bytes = readFileSync(file).length;
  console.log(`  ▣ ${name}  ${(bytes / 1024).toFixed(0)}KB`);
}

const checks = [];
function assertRendered(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) throw new Error(`断言失败：${name} → ${detail}`);
}

const base = app.url;
const page = await newPage();

try {
  // 1) 会话页（含示例提示与空产物态）
  await goto(page.sessionId, `${base}/#/agent`);
  await waitFor(page.sessionId, "document.querySelector('.ra-agent-left') && document.querySelector('.ra-agent-right')", '会话页骨架');
  const agentText = await evalJs(page.sessionId, "document.querySelector('.ra-content')?.innerText?.length ?? 0");
  assertRendered('agent 页渲染', agentText > 60, `innerText=${agentText}`);
  await shot(page.sessionId, '01-agent.png');

  // 2) 建议页（真实数据：17 行低库存）
  await goto(page.sessionId, `${base}/#/suggestions`);
  await waitFor(page.sessionId, "document.querySelectorAll('table tbody tr').length > 0", '建议表有行');
  const rows = await evalJs(page.sessionId, "document.querySelectorAll('table tbody tr').length");
  const citation = await evalJs(page.sessionId, "document.querySelector('.ra-citation')?.innerText ?? ''");
  assertRendered('suggestions 页渲染', rows >= 5, `rows=${rows} citation=${citation.slice(0, 40)}`);
  await shot(page.sessionId, '02-suggestions.png');

  // 3) 方案页
  await goto(page.sessionId, `${base}/#/plans`);
  await waitFor(page.sessionId, "document.querySelectorAll('.ra-content .ra-card, .ra-content table').length > 0", '方案页');
  await shot(page.sessionId, '03-plans.png');

  // 4) 假设页（H1–H10 可点开）
  await goto(page.sessionId, `${base}/#/assumptions`);
  await waitFor(page.sessionId, "document.body.innerText.includes('H1')", '假设页含 H1');
  const assumptionCount = await evalJs(page.sessionId, "(document.body.innerText.match(/H\\d{1,2}/g) ?? []).length");
  assertRendered('assumptions 页渲染', assumptionCount >= 8, `H 命中=${assumptionCount}`);
  await shot(page.sessionId, '04-assumptions.png');

  // 5) 审计页
  await goto(page.sessionId, `${base}/#/audit`);
  await sleep(500);
  await shot(page.sessionId, '05-audit.png');

  // 6) 草稿页 / 定时任务
  await goto(page.sessionId, `${base}/#/drafts`);
  await sleep(300);
  await shot(page.sessionId, '06-drafts.png');
  await goto(page.sessionId, `${base}/#/schedules`);
  await sleep(300);
  await shot(page.sessionId, '07-schedules.png');
  // 7) 真实会话页：REUSE_SID 直接复用已跑完的会话（省一次模型调用）；LIVE=1 则现场跑一轮
  const reuseSid = process.env.REUSE_SID || '';
  if (reuseSid) {
    await goto(page.sessionId, `${base}/#/agent?s=${reuseSid}`);
    await waitFor(page.sessionId, "document.querySelectorAll('table tbody tr').length >= 3", '右侧产物表', 20000);
    const reuseRows = await evalJs(page.sessionId, "document.querySelectorAll('table tbody tr').length");
    assertRendered('真实会话产物表渲染（复用会话）', reuseRows >= 3, `rows=${reuseRows}`);
    await shot(page.sessionId, '08-agent-live.png');
  } else if (process.env.LIVE === '1') {
    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '截图用真实会话' }),
    }).then((r) => r.json());
    const sid = created?.data?.session_id;
    console.log('  live session:', sid);
    const res = await fetch(`${base}/api/sessions/${sid}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '跑一遍补货建议，只列低库存的，然后说明前 3 个 SKU 的建议数量依据。' }),
    });
    const text = await res.text();
    const parsed = text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)));
    const artifacts = parsed.filter((e) => e.type === 'artifact').length;
    const toolCalls = parsed.filter((e) => e.type === 'tool_call').length;
    console.log(`  live: ${parsed.length} events, tool_calls=${toolCalls}, artifacts=${artifacts}`);
    assertRendered('真实会话产出 artifact', artifacts >= 1, `artifacts=${artifacts}`);

    await goto(page.sessionId, `${base}/#/agent?s=${sid}`);
    await waitFor(page.sessionId, "document.querySelectorAll('table tbody tr').length >= 3", '右侧产物表', 20000);
    const liveRows = await evalJs(page.sessionId, "document.querySelectorAll('table tbody tr').length");
    assertRendered('真实会话产物表渲染', liveRows >= 3, `rows=${liveRows}`);
    await shot(page.sessionId, '08-agent-live.png');
  }
} finally {
  page && (await browser.send('Target.closeTarget', { targetId: page.targetId }));
  console.log('\n断言汇总：', checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}`).join(' | '));
  browser.close();
  chrome.kill();
  await app.close();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
