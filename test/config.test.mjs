import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from '../server/config.mjs';

test('.env 解析：基础键值 + 注释行忽略', () => {
  const env = parseEnv('# 注释\nPORT=3200\nHOST=127.0.0.1\n\nDB_PATH=data/agent.db\n');
  assert.equal(env.PORT, '3200');
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.DB_PATH, 'data/agent.db');
  assert.equal(Object.keys(env).length, 3);
});

test('.env 解析：行内注释必须被剥离（否则 LLM_PROVIDER 会被污染成 mock）', () => {
  const env = parseEnv('LLM_PROVIDER=deepseek          # deepseek | mock（mock 为离线回放）\n');
  assert.equal(env.LLM_PROVIDER, 'deepseek');
});

test('.env 解析：引号值保留 # 与空格', () => {
  const env = parseEnv('A="x # y"\nB=\'p # q\'\nC=plain # tail\n');
  assert.equal(env.A, 'x # y');
  assert.equal(env.B, 'p # q');
  assert.equal(env.C, 'plain');
});

test('.env 解析：空值保留为空串；无 = 的行跳过；重复键后者生效', () => {
  const env = parseEnv('LLM_API_KEY=\nnonsense line\nPORT=1\nPORT=2\n');
  assert.equal(env.LLM_API_KEY, '');
  assert.equal(env.PORT, '2');
  assert.equal(env['nonsense line'], undefined);
});

test('.env 解析：URL 里的 #fragment 不受行内注释剥离影响（无前置空白）', () => {
  const env = parseEnv('BASE=https://api.example.com/v1#frag\n');
  assert.equal(env.BASE, 'https://api.example.com/v1#frag');
});

test('.env 解析：CRLF 与 BOM 兼容', () => {
  const env = parseEnv('\uFEFFPORT=3200\r\nHOST=127.0.0.1\r\n');
  assert.equal(env.PORT, '3200');
  assert.equal(env.HOST, '127.0.0.1');
});
