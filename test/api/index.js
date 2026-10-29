/**
 * test/api/index.js — `node --test test/api` 的目录入口垫片
 * ---------------------------------------------------------------------------
 * 背景（已实测）：Node **v24.16.0** 不再把目录当作 `--test` 的位置参数处理，
 * 它会把 `test/api` 当脚本入口 spawn 成 `node test/api`，于是报
 * `Cannot find module '...\test\api'`。加一个 `index.js` 后，CommonJS 目录解析命中，
 * 目录入口就会执行本文件。
 *
 * 因此：
 *  - 目录入口模式（argv[1] 是没有扩展名的目录路径）→ 逐个 import 同级测试文件；
 *  - 被默认 glob 当作普通测试文件命中时（argv[1] 以 .js 结尾）→ 什么也不做，
 *    避免 `node --test` 全量跑时把用例重复登记一遍。
 */

import path from 'node:path';

const entry = process.argv[1] ?? '';
const isDirectoryEntry = entry.length > 0 && path.extname(entry) === '';

if (isDirectoryEntry) {
  // 顺序无要求；node:test 会把它们注册进同一个进程
  await import('./validate.test.mjs');
  await import('./server.test.mjs');
  await import('./flow.test.mjs');
  await import('./sse.test.mjs');
  await import('./boot.test.mjs');
}
