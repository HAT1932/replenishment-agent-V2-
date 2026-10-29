/**
 * index.mjs — Provider 工厂
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 * 契约：contracts §5
 *   createProvider(env) -> { name, model, chat({messages,tools,signal,onDelta}) -> {message, usage}, supportsStreaming }
 *
 * 支持两种入参形状（便于 HTTP 层与服务端测试复用）：
 *   1) `loadConfig()` 的配置对象：`{ llm: { provider, baseUrl, model, apiKey, timeoutMs, maxOutputTokens, effort } }`
 *   2) 扁平环境变量：`{ LLM_PROVIDER, LLM_BASE_URL, LLM_MODEL, LLM_API_KEY, ... }`
 *
 * `provider='mock'` 时返回确定性回放 Provider（不联网、可复现），与真实 Provider 共用事件协议。
 */
import { createMockProvider } from './mock.mjs';
import { createDeepseekProvider, ProviderError } from './deepseek.mjs';

export { createMockProvider, createDeepseekProvider, ProviderError };
export { MOCK_USAGE, defaultMockPlanner } from './mock.mjs';

function normalizeConfig(env = {}) {
  if (env && typeof env === 'object' && env.llm && typeof env.llm === 'object') {
    return {
      provider: String(env.llm.provider ?? 'deepseek').toLowerCase(),
      baseUrl: env.llm.baseUrl ?? 'https://api.deepseek.com',
      apiKey: env.llm.apiKey ?? '',
      model: env.llm.model ?? 'deepseek-flash',
      timeoutMs: Number(env.llm.timeoutMs ?? 120000),
      maxOutputTokens: Number(env.llm.maxOutputTokens ?? 4096),
      effort: env.llm.effort ?? '',
      retries: env.llm.retries,
      retryBaseMs: env.llm.retryBaseMs,
      stream: env.llm.stream,
      mockScript: env.mockScript,
      fetchImpl: env.fetchImpl,
    };
  }
  const pick = (key, fallback) => {
    const value = env?.[key];
    return value === undefined || value === '' ? fallback : value;
  };
  return {
    provider: String(pick('LLM_PROVIDER', 'deepseek')).toLowerCase(),
    baseUrl: pick('LLM_BASE_URL', 'https://api.deepseek.com'),
    apiKey: pick('LLM_API_KEY', ''),
    model: pick('LLM_MODEL', 'deepseek-flash'),
    timeoutMs: Number(pick('LLM_TIMEOUT_MS', 120000)),
    maxOutputTokens: Number(pick('LLM_MAX_OUTPUT_TOKENS', 4096)),
    effort: pick('LLM_EFFORT', ''),
    retries: env?.LLM_RETRIES === undefined ? undefined : Number(env.LLM_RETRIES),
    retryBaseMs: env?.LLM_RETRY_BASE_MS === undefined ? undefined : Number(env.LLM_RETRY_BASE_MS),
    stream: env?.LLM_STREAM === undefined ? undefined : String(env.LLM_STREAM) !== 'false',
    mockScript: env?.mockScript,
    fetchImpl: env?.fetchImpl,
  };
}

/**
 * 创建 Provider。
 * @param {object} [env] loadConfig() 结果或扁平环境变量
 * @returns {{name:string, model:string, supportsStreaming:boolean, chat:Function, calls?:Array}}
 */
export function createProvider(env = {}) {
  const cfg = normalizeConfig(env);
  const provider = cfg.provider;
  if (provider === 'mock') {
    return createMockProvider({
      script: cfg.mockScript,
      name: 'mock',
      model: 'mock-deterministic',
    });
  }
  if (provider === 'deepseek' || provider === 'openai' || provider === 'openai-compatible') {
    return createDeepseekProvider({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      maxOutputTokens: cfg.maxOutputTokens,
      effort: cfg.effort,
      retries: cfg.retries,
      retryBaseMs: cfg.retryBaseMs,
      stream: cfg.stream,
      fetchImpl: cfg.fetchImpl,
    });
  }
  throw new Error(`未知 LLM provider：${provider}（可选 deepseek | mock）`);
}

export default createProvider;
