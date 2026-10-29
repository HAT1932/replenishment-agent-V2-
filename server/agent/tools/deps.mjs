/**
 * deps.mjs — 领域内核 / 数据层 / 读模型的依赖装配
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 *
 * 为什么需要这一层：
 *  - 工具层「不实现业务计算」，必须调用 `server/domain/index.mjs`（确定性内核）
 *    与 `server/data/repository.mjs` / `server/data/queries.mjs`（数据层）；
 *  - 单元测试要求离线可跑，所以支持**显式注入**假实现（{ domain, repository, queries }）；
 *  - 未注入时才惰性 import 真实模块，且失败信息可读（不会静默算错）。
 */

/**
 * @param {{domain?: object, repository?: object, queries?: object|null,
 *          loadModule?: (specifier: string) => Promise<any>}} [opts]
 */
export function createDeps(opts = {}) {
  const injected = opts.domain || opts.repository
    ? { domain: opts.domain ?? null, repository: opts.repository ?? null, queries: opts.queries ?? null }
    : null;
  const loadModule = opts.loadModule ?? ((specifier) => import(specifier));

  /** @type {Promise<{domain: object, repository: object, queries: object|null}> | null} */
  let pending = null;

  async function ensure() {
    if (injected) {
      if (!injected.domain) throw missing('domain', 'server/domain/index.mjs');
      if (!injected.repository) throw missing('repository', 'server/data/repository.mjs');
      return injected;
    }
    if (!pending) {
      pending = (async () => {
        const [domain, repository, queries] = await Promise.all([
          loadModule('../../domain/index.mjs'),
          loadModule('../../data/repository.mjs'),
          // 读模型是可选加速层：不存在时回退到 repository + domain 手工组装
          loadModule('../../data/queries.mjs').catch(() => null),
        ]);
        return { domain, repository, queries };
      })().catch((err) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  }

  return {
    ensure,
    /** 已注入的同步视图（可能为 null）；仅用于测试/调度器传参 */
    get injected() {
      return injected;
    },
  };
}

function missing(what, specifier) {
  const err = new Error(`缺少依赖：${what}（${specifier} 尚未就绪，且未在 createToolRegistry 注入）`);
  err.code = 'INTERNAL';
  return err;
}
