/**
 * index.mjs — 服务入口
 * ---------------------------------------------------------------------------
 * 两种用法：
 *  1) 被测试/验收脚本 import：`createServer({ config, db, provider })` → `{ listen, close, port, url }`
 *     - 端口传 0 时取系统随机端口，`app.port` 导出实际端口（验收脚本用）；
 *  2) 直接 `node server/index.mjs`：读 .env → 起服务 → 打印（**不打印任何 key**）→ 优雅退出。
 *
 * 依赖注入与懒加载：
 *  未传 `db` / `provider` / `deps` 时，动态 import 各层模块；任一模块尚未落地时给出明确提示，
 *  而不是在模块加载期崩掉整个进程（并行开发/增量交付友好）。
 */

import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { ROOT_DIR, loadConfig, publicConfig } from './config.mjs';
import { createRouter, todayInTimezone } from './http/router.mjs';
import { applyCommonHeaders, logAccess, notFound, redact, sendError } from './http/respond.mjs';
import { serveStatic } from './http/static.mjs';

export const SERVICE_NAME = 'replenishment-agent';

// ---------------------------------------------------------------------------
// 版本 / 模块加载
// ---------------------------------------------------------------------------

/** 读 package.json 的 version（失败不影响启动） */
export function readVersion(rootDir = ROOT_DIR) {
  try {
    const raw = readFileSync(path.join(rootDir, 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 依次尝试多个模块路径，返回第一个成功的命名空间（都失败 → null） */
async function importFirst(specs) {
  for (const spec of specs) {
    try {
      return await import(spec);
    } catch (err) {
      // 模块不存在是预期情况（并行开发期）；其它错误（语法错/依赖缺失）要留痕，
      // 否则会变成「依赖未就绪」的黑盒，排查困难
      if (err?.code !== 'ERR_MODULE_NOT_FOUND') {
        console.warn(`[server] 模块加载失败 ${spec}：${redact(err?.message ?? err)}`);
        return null;
      }
    }
  }
  return null;
}

/**
 * 解析依赖：优先用调用方注入的 stub，否则动态 import 真实模块。
 * 注意：动态 import 的说明符相对**本文件**（`server/index.mjs`）解析，
 * 所以这里一律用 `./data/...` 而不是 `../data/...`。
 * @param {{ repo?: object, queries?: object, domain?: object, agent?: object,
 *           errorMapper?: Function | null }} injected
 */
export async function resolveDeps(injected = {}) {
  const injectedAgent = injected.agent ?? {};
  // 注入了 runtime + scheduler 时（测试/stub 场景）不必再碰 agent 层模块，
  // 既省启动时间，也避免把别人的半成品模块错误刷到日志里
  const loadAgentModules = !(injectedAgent.runtime && injectedAgent.scheduler);
  const [repo, queries, domain, domainErrors, runtimeMod, schedulerMod, providersMod, toolsMod] =
    await Promise.all([
      injected.repo ?? importFirst(['./data/repository.mjs']),
      injected.queries ?? importFirst(['./data/queries.mjs']),
      injected.domain ?? importFirst(['./domain/index.mjs']),
      injected.domainErrors ?? importFirst(['./domain/errors.mjs']),
      injectedAgent.runtimeModule ?? (loadAgentModules ? importFirst(['./agent/runtime.mjs']) : null),
      injectedAgent.schedulerModule ?? (loadAgentModules ? importFirst(['./agent/scheduler.mjs']) : null),
      injectedAgent.providersModule ??
        (loadAgentModules
          ? importFirst(['./providers/index.mjs', './agent/providers/index.mjs', './providers.mjs'])
          : null),
      injectedAgent.toolsModule ??
        (loadAgentModules ? importFirst(['./agent/tools/index.mjs', './agent/tools.mjs']) : null),
    ]);

  return {
    repo: repo ?? null,
    queries: queries ?? null,
    domain: domain ?? null,
    domainErrors: domainErrors ?? null,
    errorMapper:
      injected.errorMapper ??
      (typeof domainErrors?.toErrorEnvelope === 'function' ? domainErrors.toErrorEnvelope : null),
    agent: {
      runtime: injected.agent?.runtime ?? null,
      runtimeModule: runtimeMod?.createRuntime ? runtimeMod : null,
      scheduler: injected.agent?.scheduler ?? schedulerMod ?? null,
      providersModule: providersMod ?? null,
      toolsModule: toolsMod ?? null,
    },
  };
}

/**
 * 用 agent 层工具注册表构造 tools（契约：`createToolRegistry({db, domain, repository, queries, clock, limits})`
 * → `{execute(name, args, ctx)}`）。兼容 `createTools` / `tools` / `TOOLS` 三种老写法。
 */
function buildTools(deps, { db, config }) {
  const toolsMod = deps.agent?.toolsModule;
  if (!toolsMod) return null;
  if (typeof toolsMod.createToolRegistry === 'function') {
    return toolsMod.createToolRegistry({
      db,
      domain: deps.domain,
      repository: deps.repo,
      queries: deps.queries,
      clock: () => Date.now(),
      limits: { toolTimeoutMs: config.runtime?.toolTimeoutMs },
    });
  }
  if (typeof toolsMod.createTools === 'function') {
    return toolsMod.createTools({ db, config, domain: deps.domain, repository: deps.repo });
  }
  if (toolsMod.tools) return toolsMod.tools;
  if (toolsMod.TOOLS) return toolsMod.TOOLS;
  return null;
}

/**
 * 默认 runtime（agent 层：`createRuntime({db, provider, tools, clock, limits, repository, domain})`）。
 * 注意契约细节：`clock` 是**函数** `() => number`，不是对象。
 */
async function createDefaultRuntime({ deps, db, provider, config, tools }) {
  const runtimeModule = deps.agent?.runtimeModule;
  if (!runtimeModule?.createRuntime) return null;
  return runtimeModule.createRuntime({
    db,
    provider,
    tools,
    clock: () => Date.now(),
    limits: config.runtime,
    repository: deps.repo,
    domain: deps.domain,
  });
}

/** 默认 provider（`createProvider(env)`；直接传 loadConfig() 结果，工厂原生支持 `{llm:{...}}`） */
export async function createDefaultProvider(config, deps) {
  const providersMod = deps?.agent?.providersModule;
  if (typeof providersMod?.createProvider !== 'function') {
    throw new Error('依赖未就绪：server/providers/index.mjs 未提供 createProvider');
  }
  return providersMod.createProvider(config);
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/**
 * 组装 HTTP 服务（不自动 listen）。
 * @param {{
 *   config?: object, db?: unknown, provider?: object,
 *   deps?: object, staticDir?: string, version?: string,
 *   heartbeatMs?: number, runtime?: object
 * }} [options]
 * @returns {Promise<{
 *   server: import('node:http').Server, config: object, db: unknown, provider: object,
 *   deps: object, router: object, staticDir: string, version: string,
 *   listen: (port?: number, host?: string) => Promise<object>,
 *   close: () => Promise<void>, startScheduler: (intervalMs?: number) => boolean,
 *   stopScheduler: () => void, port: number | null, url: string | null, listening: boolean
 * }>}
 */
export async function createServer(options = {}) {
  const config = options.config ?? loadConfig();
  const version = options.version ?? readVersion(config.rootDir ?? ROOT_DIR);
  const staticDir = options.staticDir ?? path.join(config.rootDir ?? ROOT_DIR, 'dist');
  const deps = await resolveDeps(options.deps ?? {});

  // 数据库：未注入时由仓储层 openDb 打开（首次会自动 seed）
  let db = options.db;
  if (db === undefined) {
    if (typeof deps.repo?.openDb !== 'function') {
      throw new Error('依赖未就绪：server/data/repository.mjs 未提供 openDb，且未注入 db');
    }
    db = deps.repo.openDb(config.dbPath);
  }

  // Provider：未注入时用 agent 层的工厂；都不可用时退化为「不可用」探针（保证健康检查可跑，
  // 真正发起对话时会以 UPSTREAM_LLM_ERROR 明确失败，绝不伪造结果）
  let provider = options.provider;
  if (!provider) {
    try {
      provider = await createDefaultProvider(config, deps);
    } catch (err) {
      console.warn(`[server] provider 不可用：${redact(err?.message ?? err)}`);
      provider = {
        name: config.llm.provider,
        model: config.llm.model,
        supportsStreaming: false,
        unavailable: true,
        async chat() {
          throw Object.assign(new Error('LLM Provider 不可用（未完成配置或模块缺失）'), {
            code: 'UPSTREAM_LLM_ERROR',
          });
        },
      };
    }
  }

  // 工具注册表：只构造一次（runtime 与 scheduler 手动触发共用同一份）
  const tools = options.tools ?? deps.agent.tools ?? buildTools(deps, { db, config });

  // Runtime：未注入时尝试构造；工具表缺失/模块半成品时降级为 null（路由会明确报 INTERNAL），
  // 不能因为 agent 层还没完工就让整个 HTTP 服务起不来
  let runtime = options.runtime ?? deps.agent.runtime ?? null;
  if (!runtime) {
    try {
      runtime = await createDefaultRuntime({ deps, db, provider, config, tools });
    } catch (err) {
      console.warn(`[server] runtime 不可用：${redact(err?.message ?? err)}`);
      runtime = null;
    }
  }
  const agentDeps = {
    ...deps.agent,
    runtime,
    provider,
    tools,
    repository: deps.repo,
    domain: deps.domain,
    queries: deps.queries,
  };

  const baseInfo = publicConfig(config);
  const providerInfo = {
    provider: provider?.name ?? baseInfo.provider,
    model: provider?.model ?? baseInfo.model,
  };

  const router = createRouter({
    config,
    db,
    provider,
    deps: { ...deps, agent: agentDeps },
    version,
    staticDir,
    providerInfo,
    heartbeatMs: options.heartbeatMs,
  });

  const sockets = new Set();
  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  function safePathname(rawUrl) {
    try {
      return new URL(rawUrl ?? '/', 'http://localhost').pathname;
    } catch {
      return String(rawUrl ?? '/');
    }
  }

  async function handleRequest(req, res) {
    const started = process.hrtime.bigint();
    const pathname = safePathname(req.url);
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      // 静态资源 2xx 不刷日志；API 与错误一律记（只记方法/路径/状态/耗时）
      const isApi = pathname === '/api' || pathname.startsWith('/api/');
      if (!isApi && res.statusCode < 400) return;
      logAccess({ method: req.method, pathname, status: res.statusCode, durationMs });
    });

    try {
      applyCommonHeaders(res, { api: false });
      const handled = await router.handle(req, res);
      if (handled) return;

      const served = await serveStatic(req, res, { distDir: staticDir });
      if (served) return;

      applyCommonHeaders(res, { api: false });
      sendError(res, notFound(`未找到：${req.method} ${pathname}`));
    } catch (err) {
      // 控制器全兜底：绝不让异常冒到 uncaughtException
      console.error('[server] 请求处理异常：', redact(err?.stack ?? err?.message ?? err));
      if (res.headersSent) {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      applyCommonHeaders(res, { api: false });
      sendError(res, err);
    }
  }

  let schedulerTimer = null;

  function startScheduler(intervalMs = 60_000) {
    const sch = agentDeps.scheduler;
    if (schedulerTimer || typeof sch?.runDueSchedules !== 'function') return false;
    const tick = () => {
      Promise.resolve()
        .then(() => sch.runDueSchedules({ db, runtime, now: new Date().toISOString() }))
        .catch((err) => console.warn('[scheduler] 运行失败：', redact(err?.message ?? err)));
    };
    schedulerTimer = setInterval(tick, intervalMs);
    schedulerTimer.unref?.();
    tick();
    return true;
  }

  function stopScheduler() {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }

  const app = {
    server,
    config,
    db,
    provider,
    deps: { ...deps, agent: agentDeps },
    router,
    staticDir,
    version,
    listen(port = config.port ?? 3200, host = config.host ?? '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(app);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    async close() {
      stopScheduler();
      await new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        // 先断 keep-alive 长连接，否则 close 会一直等下去（SSE/前端轮询场景）
        server.closeAllConnections?.();
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
        }
        server.close(() => resolve());
      });
      try {
        db?.close?.();
      } catch {
        /* 已关闭 */
      }
    },
    startScheduler,
    stopScheduler,
    get port() {
      const address = server.address();
      return address && typeof address === 'object' ? address.port : null;
    },
    get url() {
      const address = server.address();
      if (!address || typeof address !== 'object') return null;
      const host = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
      return `http://${host}:${address.port}`;
    },
    get listening() {
      return server.listening;
    },
  };

  return app;
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

/** 直接执行时启动（被 import 时不启动） */
export async function main() {
  const config = loadConfig();
  const app = await createServer({ config });
  await app.listen(config.port, config.host);
  const info = publicConfig(config);

  console.log(`[server] ${SERVICE_NAME} 已启动：${app.url}`);
  console.log(
    `[server] provider=${info.provider} model=${info.model}${
      info.degraded_reason ? `（${info.degraded_reason}）` : ''
    }`,
  );
  console.log(`[server] db=${config.dbPath}`);
  console.log(`[server] static=${app.staticDir}`);
  console.log('[server] Ctrl+C 退出');

  app.startScheduler();

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[server] 收到 ${signal}，正在关闭…`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  return app;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[server] 启动失败：', redact(err?.stack ?? err?.message ?? err));
    process.exit(1);
  });
}

export default createServer;
