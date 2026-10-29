/**
 * test/api/sse.test.mjs — SSE 协议正确性（分帧 / 心跳 / 断开中止 / 错误事件）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectSse, createStubRepo, createStubRuntime, startTestServer } from './helpers.mjs';

async function createSession(server, title = 'SSE 测试') {
  const { body, status } = await server.postJson('/api/sessions', { title });
  assert.equal(status, 201);
  return body.data.session_id;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** 按前端规则解析：`data: ` 前缀 + 空行切分 */
function parseFrames(raw) {
  const events = [];
  const comments = [];
  const invalid = [];
  for (const frame of raw.split('\n\n')) {
    if (!frame) continue;
    if (frame.startsWith('data: ')) {
      const payload = frame.slice('data: '.length);
      // 单条事件必须是单行（不能出现多行 data）
      if (payload.includes('\n')) invalid.push(frame);
      events.push(JSON.parse(payload));
    } else if (frame.startsWith(':')) {
      comments.push(frame);
    } else if (frame.trim()) {
      invalid.push(frame);
    }
  }
  return { events, comments, invalid };
}

test('SSE：响应头、事件完整性、seq 单调递增、单行 data', async (t) => {
  const repo = createStubRepo();
  const runtime = createStubRuntime({ delayMs: 5 });
  const { base, postJson } = await startTestServer(t, { repo, runtime });
  const sessionId = await createSession({ postJson });

  const res = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content: '帮我看下 SKU-001 要不要补货' }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(res.headers.get('connection'), 'keep-alive');
  assert.equal(res.headers.get('x-accel-buffering'), 'no');

  const raw = await res.text();
  const { events, invalid } = parseFrames(raw);
  assert.deepEqual(invalid, [], '存在非标准帧');

  // 事件类型覆盖契约 §5 的主要类型
  const types = events.map((event) => event.type);
  for (const expected of [
    'session',
    'step',
    'reasoning_delta',
    'tool_call',
    'tool_result',
    'artifact',
    'approval_required',
    'usage',
    'assistant_delta',
    'done',
  ]) {
    assert.ok(types.includes(expected), `缺少事件类型 ${expected}`);
  }

  // seq 必须从 1 起严格单调递增
  const seqs = events.map((event) => event.seq);
  assert.equal(seqs[0], 1);
  for (let index = 1; index < seqs.length; index += 1) {
    assert.ok(seqs[index] > seqs[index - 1], `seq 非单调：${seqs[index - 1]} → ${seqs[index]}`);
  }

  // done 必须是最后一条，且 finish_reason 有值
  const last = events.at(-1);
  assert.equal(last.type, 'done');
  assert.ok(typeof last.finish_reason === 'string');

  // 工具事件能按 call_id 关联
  const call = events.find((event) => event.type === 'tool_call');
  const result = events.find((event) => event.type === 'tool_result');
  assert.equal(call.call_id, result.call_id);
  assert.equal(call.name, result.name);

  // 用户消息落库
  const messages = repo._messages.get(sessionId) ?? [];
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
});

test('SSE：心跳 `: ping` 在生成过程中按间隔出现', async (t) => {
  const runtime = createStubRuntime({ delayMs: 80 });
  const { base, postJson } = await startTestServer(t, { runtime, heartbeatMs: 60 });
  const sessionId = await createSession({ postJson });

  const res = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content: '生成建议' }),
  });
  const raw = await res.text();
  const { comments } = parseFrames(raw);

  assert.ok(comments.some((line) => line === ': open'), '缺少开流注释帧');
  assert.ok(comments.includes(': ping'), `心跳缺失：${JSON.stringify(comments.slice(0, 5))}`);
});

test('SSE：runtime 报错 → error 事件 + done(error)，不伪造结果', async (t) => {
  const runtime = {
    calls: [],
    async run({ onEvent }) {
      onEvent({ type: 'session', session_id: 's' });
      throw Object.assign(new Error('上游 502'), { code: 'UPSTREAM_LLM_ERROR' });
    },
  };
  const { base, postJson } = await startTestServer(t, { runtime });
  const sessionId = await createSession({ postJson });

  const res = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content: '触发失败' }),
  });
  const { events } = parseFrames(await res.text());
  const errorEvent = events.find((event) => event.type === 'error');
  assert.ok(errorEvent, '缺少 error 事件');
  assert.equal(errorEvent.code, 'UPSTREAM_LLM_ERROR');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).finish_reason, 'error');
});

test('SSE：客户端断开 → AbortController.abort()，runtime 与审计标记 aborted', async (t) => {
  const repo = createStubRepo();
  const controller = new AbortController();
  const runtime = {
    calls: [],
    async run({ onEvent, signal }) {
      this.calls.push({ onEvent, signal });
      onEvent({ type: 'session', session_id: 's' });
      return new Promise((resolve) => {
        const finish = () => resolve({ finish_reason: 'aborted' });
        if (signal.aborted) return finish();
        signal.addEventListener('abort', finish, { once: true });
        setTimeout(finish, 5000).unref?.();
      });
    },
  };
  const { base, postJson } = await startTestServer(t, { repo, runtime });
  const sessionId = await createSession({ postJson });

  const res = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content: '长对话' }),
    signal: controller.signal,
  });
  assert.equal(res.status, 200);

  const reader = res.body.getReader();
  await reader.read(); // 至少收到开流帧
  controller.abort(); // 模拟用户关闭页面/网络断开

  // 等服务端把 abort 传下去
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !runtime.calls[0]?.signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].signal.aborted, true, 'runtime 的 signal 未被 abort');

  // 等审计落库
  while (Date.now() < deadline && repo._audit.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const abortedAudit = repo._audit.find((event) => event.kind === 'turn_aborted');
  assert.ok(abortedAudit, '未记录 turn_aborted 审计');
  assert.equal(abortedAudit.ok, false);
  assert.equal(abortedAudit.payload.reason, 'client_disconnected');

  await reader.cancel().catch(() => {});
});

test('SSE 前置校验：会话不存在/内容为空 → JSON 错误信封（不开启事件流）', async (t) => {
  const { base, json, postJson } = await startTestServer(t);
  const sessionId = await createSession({ postJson });

  const missing = await json('/api/sessions/sess_nope/messages', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content: 'hi' }),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  assert.match(missing.res.headers.get('content-type') ?? '', /application\/json/);

  const empty = await json(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content: '   ' }),
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'VALIDATION_ERROR');
  assert.equal(empty.body.error.details.fields[0].field, 'content');
});

test('SSE：collectSse 流式读取（与前端 read loop 同路径）', async (t) => {
  const runtime = createStubRuntime({ delayMs: 1 });
  const { base, postJson } = await startTestServer(t, { runtime });
  const sessionId = await createSession({ postJson });

  const res = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content: '流式' }),
  });
  const { events } = await collectSse(res);
  assert.ok(events.length >= 10);
  assert.equal(events.at(-1).type, 'done');
});
