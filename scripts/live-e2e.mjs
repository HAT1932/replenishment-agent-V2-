/**
 * live-e2e.mjs — 真实模型端到端（进程内起服务，不依赖外部进程管理）
 * 验证：SSE 事件协议 → 工具调用 → 建议产物 → 草稿 → 审批卡 → 审计落库
 */
import { rmSync } from 'node:fs';

process.env.DB_PATH = process.env.DB_PATH || 'data/live-e2e.db';
process.env.PORT = process.env.PORT || '3213';
rmSync(process.env.DB_PATH, { force: true });
rmSync(`${process.env.DB_PATH}-wal`, { force: true });
rmSync(`${process.env.DB_PATH}-shm`, { force: true });

const { createServer } = await import('../server/index.mjs');
const app = await createServer();
await app.listen(Number(process.env.PORT), '127.0.0.1');
const BASE = app.url;
console.log('server:', BASE, 'provider:', app.provider?.name, 'model:', app.provider?.model);

const j = async (p, init) => {
  const r = await fetch(BASE + p, init);
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    return { status: r.status, body: t };
  }
};
const post = (p, payload) =>
  j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}) });

let exitCode = 0;
try {
  const created = await post('/api/sessions', { title: '真实模型端到端' });
  const sid = created.body.data.session_id;
  console.log('session:', sid);

  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/sessions/${sid}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '现在哪些商品需要补货？先跑一遍补货建议，然后给出前 3 个 SKU 的建议数量，并说明依据。',
    }),
  });
  console.log('SSE status:', res.status, '| content-type:', res.headers.get('content-type'));

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  let assistant = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (frame.startsWith('data: ')) {
        const event = JSON.parse(frame.slice(6));
        events.push(event);
        if (event.type === 'tool_call') console.log('  → tool_call', event.name, JSON.stringify(event.args ?? {}).slice(0, 110));
        if (event.type === 'tool_result') console.log('  ← tool_result', event.name, 'ok=' + event.ok, `${event.duration_ms}ms`, String(event.summary ?? '').slice(0, 100));
        if (event.type === 'artifact') console.log('  ▣ artifact', event.artifact.kind, '|', event.artifact.title);
        if (event.type === 'approval_required') console.log('  ⚑ approval', event.approval.kind, event.approval.risk, JSON.stringify(event.approval.ref ?? {}).slice(0, 90));
        if (event.type === 'assistant_delta') assistant += event.text ?? '';
        if (event.type === 'error') { console.log('  ✖ error', event.code, event.message); exitCode = 1; }
        if (event.type === 'usage') console.log('  Σ usage', JSON.stringify({ p: event.prompt_tokens, c: event.completion_tokens, r: event.reasoning_tokens }));
        if (event.type === 'done') console.log('  ✓ done', event.finish_reason);
      }
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const types = [...new Set(events.map((e) => e.type))];
  console.log(`\nevents=${events.length} elapsed=${elapsed}s\ntypes: ${types.join(', ')}`);
  console.log('seq 单调:', events.every((e, i) => i === 0 || e.seq > events[i - 1].seq));
  console.log('assistant 摘要:', assistant.replace(/\s+/g, ' ').slice(0, 220));

  const detail = await j(`/api/sessions/${sid}`);
  console.log('messages:', detail.body.data?.messages?.length, '| roles:', detail.body.data?.messages?.map((m) => m.role).join(','));
  console.log('artifacts:', detail.body.data?.artifacts?.length, '| kinds:', detail.body.data?.artifacts?.map((a) => a.kind).join(','));
  const audit = await j(`/api/audit?session_id=${sid}&limit=100`);
  const kinds = [...new Set((audit.body.data?.events ?? []).map((e) => e.kind))];
  console.log('audit events:', audit.body.data?.events?.length, '| kinds:', kinds.join(','));
  console.log('tool 审计条数:', (audit.body.data?.events ?? []).filter((e) => e.kind === 'tool_call').length);
} catch (err) {
  console.error('LIVE FAIL:', err);
  exitCode = 1;
} finally {
  await app.close();
  process.exit(exitCode);
}
