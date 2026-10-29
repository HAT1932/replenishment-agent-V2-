/**
 * test/api/boot.test.mjs — 真机启动冒烟（**不注入任何 stub**）
 * ---------------------------------------------------------------------------
 * 为什么需要它：其余 API 测试都注入了 stub，走不到 `resolveDeps()` 的动态 import；
 * 曾经因此漏掉「相对路径写错 → 真机报依赖未就绪」的问题。
 * 这里用真实 repository / domain / queries + 临时 DB + 端口 0，只断言最稳的两条。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createServer, resolveDeps } from '../../server/index.mjs';
import { loadConfig } from '../../server/config.mjs';
import { PROJECT_ROOT } from './helpers.mjs';

test('resolveDeps：默认路径能加载到真实仓储/域层/读模型', async () => {
  const deps = await resolveDeps();
  assert.ok(deps.repo, '未加载到 server/data/repository.mjs');
  assert.ok(deps.queries, '未加载到 server/data/queries.mjs');
  assert.ok(deps.domain, '未加载到 server/domain/index.mjs');
  assert.equal(typeof deps.repo.openDb, 'function');
  assert.equal(typeof deps.queries.buildSuggestions, 'function');
  assert.equal(typeof deps.domain.ASSUMPTIONS !== 'undefined', true);
  assert.equal(typeof deps.errorMapper, 'function', '未加载到 domain/errors.mjs 的 toErrorEnvelope');
});

test('真机启动：临时 DB + 端口 0 → /api/health 与 /api/plans 200', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'repl-boot-'));
  const dbPath = path.join(dir, 'boot.db');
  const config = loadConfig({
    rootDir: PROJECT_ROOT,
    env: { ...process.env, DB_PATH: dbPath, PORT: '0', HOST: '127.0.0.1', LLM_PROVIDER: 'mock' },
  });
  assert.equal(config.dbPath, dbPath);

  const app = await createServer({ config });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  await app.listen(0, '127.0.0.1');

  assert.ok(app.port > 0, '端口 0 未取到实际端口');
  assert.equal(app.url, `http://127.0.0.1:${app.port}`);

  const health = await (await fetch(`${app.url}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.data.status, 'ok');
  assert.equal(health.data.service, 'replenishment-agent');
  assert.equal(health.data.provider, 'mock');
  assert.match(health.data.today, /^\d{4}-\d{2}-\d{2}$/);

  const plans = await fetch(`${app.url}/api/plans`);
  assert.equal(plans.status, 200);
  const planBody = await plans.json();
  assert.equal(planBody.ok, true);
  assert.ok(Array.isArray(planBody.data.plans) && planBody.data.plans.length >= 2);

  // 真库的 meta 也得通（说明 seed 生效）
  const meta = await (await fetch(`${app.url}/api/meta`)).json();
  assert.equal(meta.ok, true);
  assert.ok(meta.data.today);
  assert.ok(meta.data.stores.length >= 1);
});
