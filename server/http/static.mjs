/**
 * static.mjs — `dist/` 静态资源服务 + SPA fallback
 * ---------------------------------------------------------------------------
 * 硬性要求（任务 §3.5）：
 *  - 禁止目录穿越：`..`、绝对路径、NUL、URL 二次编码都要挡掉；
 *  - 正确 MIME（`.mjs` 必须是 `text/javascript`，否则浏览器拒绝作为 ES module 执行）；
 *  - 缓存头：`/assets/*`（带内容 hash）→ immutable 一年；`index.html` → no-cache；
 *  - SPA fallback：不是文件且请求 `Accept` 含 `text/html` → 回 `index.html`；
 *  - `/api/*` 优先，这里永不处理（由 router 先判定）。
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { HTML_CSP, sendText } from './respond.mjs';

/** 扩展名 → Content-Type（含 charset 的按需拼接） */
const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
});

export function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 把 URL pathname 安全地映射到 dist 内的绝对路径。
 * 返回 null 表示非法（穿越/编码异常/含 NUL）。
 * @param {string} distDir
 * @param {string} pathname 已经过 URL 解析的原始 pathname
 * @returns {string | { error: 400 | 403 }}
 */
export function resolveSafePath(distDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { error: 400 }; // 非法百分号编码
  }
  if (decoded.includes('\0')) return { error: 400 };
  // 统一分隔符后再做穿越判定（Windows 下 \ 也是分隔符）
  const normalized = decoded.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (segments.some((seg) => seg === '..')) return { error: 403 };

  const root = path.resolve(distDir);
  const target = path.resolve(root, ...segments);
  // 双保险：解析后必须仍在 root 之内（防符号链接以外的甜点，如 `....//`）
  if (target !== root && !target.startsWith(root + path.sep)) return { error: 403 };
  return target;
}

function acceptsHtml(req) {
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/html') || accept.includes('application/xhtml+xml');
}

function buildAssetHeaders(filePath, statResult, { html }) {
  const headers = {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': String(statResult.size),
    'Last-Modified': statResult.mtime.toUTCString(),
    ETag: `W/"${statResult.size.toString(16)}-${Math.floor(statResult.mtimeMs).toString(16)}"`,
  };
  if (html) {
    headers['Cache-Control'] = 'no-cache';
    headers['Content-Security-Policy'] = HTML_CSP;
  } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    // Vite 产物带内容 hash，可长期缓存
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'public, max-age=3600';
  }
  return headers;
}

function notModified(req, etag) {
  const ifNoneMatch = req.headers['if-none-match'];
  if (!ifNoneMatch) return false;
  return String(ifNoneMatch)
    .split(',')
    .map((part) => part.trim())
    .includes(etag);
}

/**
 * 尝试用 dist 静态资源响应请求。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ distDir: string, fallbackToIndex?: boolean }} options
 * @returns {Promise<boolean>} true = 已处理（响应已结束）；false = 未处理（交给上层 404）
 */
export async function serveStatic(req, res, { distDir, fallbackToIndex = true } = {}) {
  const method = String(req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;

  let pathname;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return false;
  }
  if (pathname.startsWith('/api/') || pathname === '/api') return false;

  const resolved = resolveSafePath(distDir, pathname);
  if (resolved && typeof resolved === 'object') {
    sendText(res, resolved.error === 403 ? 403 : 400, resolved.error === 403 ? '403 禁止访问' : '400 请求路径非法');
    return true;
  }

  const indexFile = path.join(path.resolve(distDir), 'index.html');
  let target = resolved;
  let fileStat = await statOrNull(target);

  // 目录请求 → 目录下 index.html
  if (fileStat?.isDirectory()) {
    target = path.join(target, 'index.html');
    fileStat = await statOrNull(target);
  }

  // 不是文件：SPA fallback（仅 HTML 导航请求）
  if (!fileStat?.isFile()) {
    if (!fallbackToIndex) return false;
    if (path.extname(pathname) && pathname !== '/index.html') {
      // 明确要一个静态文件（.js/.css/.png…）却没找到 → 真 404，别回 index.html 骗浏览器
      return false;
    }
    if (!acceptsHtml(req) && pathname !== '/') return false;
    target = indexFile;
    fileStat = await statOrNull(target);
    if (!fileStat?.isFile()) {
      // 还没 build：给出可执行的提示，而不是空 404
      sendText(
        res,
        503,
        '前端尚未构建：请先执行 `npm run build`（产物目录 dist/），或使用 `npm run dev:web` 启动 vite 开发服务器。',
      );
      return true;
    }
  }

  const isHtml = path.extname(target).toLowerCase() === '.html';
  const headers = buildAssetHeaders(target, fileStat, { html: isHtml });

  if (notModified(req, headers.ETag)) {
    res.statusCode = 304;
    res.setHeader('ETag', headers.ETag);
    res.setHeader('Cache-Control', headers['Cache-Control']);
    res.end();
    return true;
  }

  res.statusCode = 200;
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  if (method === 'HEAD') {
    res.end();
    return true;
  }

  await new Promise((resolve) => {
    const stream = createReadStream(target);
    stream.on('error', () => {
      // 读盘失败时如果还没写响应体，补一个 500
      if (!res.headersSent) sendText(res, 500, '500 静态资源读取失败');
      else res.destroy();
      resolve();
    });
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}

async function statOrNull(target) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

export default { serveStatic, resolveSafePath, contentTypeFor };
