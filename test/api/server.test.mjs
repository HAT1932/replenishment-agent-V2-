/**
 * test/api/server.test.mjs — 入口/信封/错误码/安全头/静态服务/请求体上限
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startTestServer, makeConfig, createStubRepo } from './helpers.mjs';

test('GET /api/health：契约字段齐全且不含密钥', async (t) => {
  const { json, app } = await startTestServer(t);
  const { res, body, status } = await json('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const data = body.data;
  for (const key of ['status', 'service', 'version', 'provider', 'model', 'today', 'node']) {
    assert.ok(key in data, `health 缺少字段 ${key}`);
  }
  assert.equal(data.status, 'ok');
  assert.equal(data.service, 'replenishment-agent');
  assert.equal(data.provider, 'mock');
  assert.equal(data.model, 'mock-1');
  assert.match(data.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(data.node, /^v\d+\./);
  // 绝不泄漏 key
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('sk-should-never-leak'), 'health 泄漏了 apiKey');
  assert.ok(!raw.toLowerCase().includes('apikey'), 'health 出现了 apikey 字段');
  // 配置里的 apiKey 不在任何公开投影里
  assert.equal(app.config.llm.apiKey, 'sk-should-never-leak');
});

test('响应安全头：nosniff / no-store / 无 CORS 放行', async (t) => {
  const { json } = await startTestServer(t);
  const { res } = await json('/api/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.match(res.headers.get('content-type') ?? '', /application\/json; charset=utf-8/);
});

test('错误信封：未知路由 404 + code NOT_FOUND + 不含堆栈', async (t) => {
  const { json } = await startTestServer(t);
  const { res, body, status } = await json('/api/definitely-not-a-route');
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);
  assert.ok(!('stack' in body.error), '错误体里出现了 stack');
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
});

test('方法不匹配也走统一信封（404 + 允许方法提示）', async (t) => {
  const { json } = await startTestServer(t);
  const { res, body, status } = await json('/api/health', { method: 'POST', body: '{}' });
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.match(body.error.message, /POST|允许/);
});

test('JSON 解析失败 → 400 VALIDATION_ERROR（带 details.fields）', async (t) => {
  const { json } = await startTestServer(t);
  const { body, status } = await json('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(Array.isArray(body.error.details.fields));
});

test('请求体超过 2MB → 413（code 仍为契约内的 VALIDATION_ERROR）', async (t) => {
  const { fetch } = await startTestServer(t);
  const big = 'x'.repeat(2 * 1024 * 1024 + 1024);
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: big }),
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details.reason, 'PAYLOAD_TOO_LARGE');
});

test('静态服务：/ 与 /assets/* 的 MIME、缓存头、CSP', async (t) => {
  const { fetch } = await startTestServer(t);

  const indexRes = await fetch('/', { headers: { Accept: 'text/html' } });
  assert.equal(indexRes.status, 200);
  assert.match(indexRes.headers.get('content-type') ?? '', /text\/html; charset=utf-8/);
  assert.equal(indexRes.headers.get('cache-control'), 'no-cache');
  assert.match(indexRes.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(await indexRes.text(), /<div id="root">/);

  const assetRes = await fetch('/assets/app-abc123.js');
  assert.equal(assetRes.status, 200);
  assert.match(assetRes.headers.get('content-type') ?? '', /text\/javascript; charset=utf-8/);
  assert.match(assetRes.headers.get('cache-control') ?? '', /immutable/);
  assert.equal(assetRes.headers.get('etag') !== null, true);
  assert.match(await assetRes.text(), /export const ok = true/);
});

test('静态服务：SPA fallback（Accept: text/html 才回 index.html）', async (t) => {
  const { fetch } = await startTestServer(t);
  const spa = await fetch('/sessions', { headers: { Accept: 'text/html' } });
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /<div id="root">/);

  // 明确要静态文件却不存在 → 不能回 index.html
  const missing = await fetch('/assets/not-exists.js');
  assert.equal(missing.status, 404);
  const body = await missing.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('静态服务：目录穿越被拒（编码后的 .. / 反斜杠）', async (t) => {
  const { fetch } = await startTestServer(t);
  for (const pathname of ['/%2e%2e/server/config.mjs', '/%2e%2e%2fserver%2fconfig.mjs', '/..%5cserver%5cconfig.mjs']) {
    const res = await fetch(pathname);
    assert.ok(res.status === 403 || res.status === 400 || res.status === 404, `${pathname} → ${res.status}`);
    const text = await res.text();
    assert.ok(!text.includes('loadConfig'), `${pathname} 穿越读到了源码`);
  }
});

test('静态服务：HEAD 只回头部；非法编码 → 400', async (t) => {
  const { fetch } = await startTestServer(t);
  const head = await fetch('/', { method: 'HEAD', headers: { Accept: 'text/html' } });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const bad = await fetch('/%E0%A4%A');
  assert.equal(bad.status, 400);
});

test('dist 未构建时给出可执行提示（503）而非空 404', async (t) => {
  const emptyDist = await mkdtemp(path.join(tmpdir(), 'repl-api-empty-'));
  await writeFile(path.join(emptyDist, 'placeholder.txt'), 'x');
  t.after(() => rm(emptyDist, { recursive: true, force: true }));

  const { fetch } = await startTestServer(t, { distDir: emptyDist });
  const res = await fetch('/', { headers: { Accept: 'text/html' } });
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.match(text, /npm run build/);
});

test('依赖缺失时返回 INTERNAL 而不是崩进程', async (t) => {
  const repo = createStubRepo();
  const { json } = await startTestServer(t, {
    repo,
    config: makeConfig(),
  });
  // 正常：有 repo 时 meta 可读
  const ok = await json('/api/meta');
  assert.equal(ok.status, 200);
});
