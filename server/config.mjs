/**
 * config.mjs — 配置加载（零依赖 .env 解析）
 * ---------------------------------------------------------------------------
 * 设计取舍：
 *  1) 不引 dotenv：只支持 `KEY=VALUE` 与 `#` 注释，够用且零依赖；
 *  2) 已存在的 process.env 优先（便于测试与 CI 覆盖）；
 *  3) **不在任何日志/接口里输出 API key**；对外只暴露 provider/model。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));

/** 解析 .env 文本（不写 process.env） */
export function parseEnv(text) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // 支持行内注释：KEY=value   # 说明 —— 否则 .env.example 的示例注释会被当成值，
      // 导致 LLM_PROVIDER 变成 "deepseek  # deepseek | mock" 而静默降级成 mock（踩过）。
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[key] = value;
  }
  return out;
}

/** 读取 .env（如果存在），返回合并后的配置对象 */
export function loadConfig({ rootDir = ROOT_DIR, env = process.env } = {}) {
  const envPath = path.join(rootDir, '.env');
  const fileEnv = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const get = (k, fallback = '') => {
    const v = env[k] !== undefined && env[k] !== '' ? env[k] : fileEnv[k];
    return v === undefined || v === '' ? fallback : v;
  };

  const provider = String(get('LLM_PROVIDER', 'deepseek')).toLowerCase();
  const cfg = {
    rootDir,
    port: Number(get('PORT', '3200')),
    host: get('HOST', '127.0.0.1'),
    dbPath: path.isAbsolute(get('DB_PATH', 'data/agent.db'))
      ? get('DB_PATH', 'data/agent.db')
      : path.join(rootDir, get('DB_PATH', 'data/agent.db')),
    tzOffset: get('TZ_OFFSET', '+08:00'),
    llm: {
      provider,
      baseUrl: get('LLM_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
      model: get('LLM_MODEL', 'deepseek-flash'),
      apiKey: get('LLM_API_KEY', ''),
      timeoutMs: Number(get('LLM_TIMEOUT_MS', '120000')),
      maxOutputTokens: Number(get('LLM_MAX_OUTPUT_TOKENS', '4096')),
      effort: get('LLM_EFFORT', ''), // deepseek-flash 支持 low|high|max
    },
    runtime: {
      maxSteps: Number(get('AGENT_MAX_STEPS', '8')),
      maxToolCallsPerTurn: Number(get('AGENT_MAX_TOOL_CALLS', '12')),
      turnBudgetMs: Number(get('AGENT_TURN_BUDGET_MS', '180000')),
      toolTimeoutMs: Number(get('AGENT_TOOL_TIMEOUT_MS', '20000')),
    },
  };
  // 无 key 自动降级到 mock，保证离线可跑（但会在 /api/health 明示）
  if (cfg.llm.provider === 'deepseek' && !cfg.llm.apiKey) {
    cfg.llm.provider = 'mock';
    cfg.llm.degraded_reason = 'LLM_API_KEY 为空，已降级为 mock provider';
  }
  return cfg;
}

/** 给 /api/health 用的安全投影：绝不返回 apiKey */
export function publicConfig(cfg) {
  return {
    provider: cfg.llm.provider,
    model: cfg.llm.model,
    base_url: cfg.llm.baseUrl,
    degraded_reason: cfg.llm.degraded_reason ?? null,
    runtime: cfg.runtime,
  };
}

export const config = loadConfig();
export default config;
