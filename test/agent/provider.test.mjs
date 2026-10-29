/**
 * provider.test.mjs — Provider 抽象：mock 确定性回放 + DeepSeek 流式/重试/错误映射
 * 自测：node --test test/agent
 * 全部使用注入的 fetchImpl，**不联网**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockProvider, MOCK_USAGE } from '../../server/providers/mock.mjs';
import { createDeepseekProvider, ProviderError } from '../../server/providers/deepseek.mjs';
import { createProvider } from '../../server/providers/index.mjs';

const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function sseResponse(parts) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(parts.join('')));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

const OK_SSE = [
  chunk({ choices: [{ delta: { reasoning_content: '想一想' } }] }),
  chunk({ choices: [{ delta: { content: '你好' } }] }),
  chunk({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'catalog.list_skus', arguments: '{"lim' } },
          ],
        },
      },
    ],
  }),
  chunk({
    choices: [
      {
        delta: { tool_calls: [{ index: 0, function: { arguments: 'it":5}' } }] },
        finish_reason: 'tool_calls',
      },
    ],
  }),
  chunk({
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 3 } },
  }),
  'data: [DONE]\n\n',
];

const TOOLS = [
  {
    type: 'function',
    function: { name: 'catalog__list_skus', description: '列出 SKU', parameters: { type: 'object', properties: {} } },
  },
];

test('DeepSeek 流式：reasoning/content 分离、tool_calls 增量拼装、usage 映射', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return sseResponse(OK_SSE);
  };
  const provider = createDeepseekProvider({ apiKey: 'test-key', fetchImpl, retryBaseMs: 1 });
  const deltas = [];
  const result = await provider.chat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: TOOLS,
    onDelta: (d) => deltas.push(d),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].body.model, 'deepseek-flash');
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.stream_options.include_usage, true);
  assert.deepEqual(calls[0].body.tools, TOOLS);

  assert.equal(result.message.content, '你好');
  assert.equal(result.message.reasoning_content, '想一想');
  assert.equal(result.message.tool_calls.length, 1);
  assert.equal(result.message.tool_calls[0].id, 'call_1');
  assert.equal(result.message.tool_calls[0].function.name, 'catalog.list_skus');
  assert.equal(result.message.tool_calls[0].function.arguments, '{"limit":5}');
  assert.equal(result.finish_reason, 'tool_calls');
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 7, reasoning_tokens: 3 });

  assert.deepEqual(deltas.map((d) => d.type), ['reasoning', 'content']);
  assert.equal(deltas[0].text, '想一想');
  assert.equal(deltas[1].text, '你好');
});

test('DeepSeek 429 重试（≤2 次，指数退避）后成功', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    if (count === 1) return new Response('rate limited', { status: 429 });
    return sseResponse(OK_SSE);
  };
  const provider = createDeepseekProvider({ apiKey: 'k', fetchImpl, retryBaseMs: 1 });
  const result = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(count, 2);
  assert.equal(result.message.content, '你好');
});

test('DeepSeek 5xx 重试两次后仍失败 → ProviderError(retryable)', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    return new Response('boom', { status: 503 });
  };
  const provider = createDeepseekProvider({ apiKey: 'k', fetchImpl, retryBaseMs: 1, retries: 2 });
  await assert.rejects(
    () => provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, 'UPSTREAM_LLM_ERROR');
      assert.equal(err.status, 503);
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(count, 3, '首次 + 2 次重试');
});

test('DeepSeek 4xx（非 400 兼容回退）不重试，错误映射为 UPSTREAM_LLM_ERROR（不泄露 key）', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    return new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 401 });
  };
  const provider = createDeepseekProvider({ apiKey: 'super-secret-key', fetchImpl, retryBaseMs: 1 });
  await assert.rejects(
    () => provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.status, 401);
      assert.equal(err.retryable, false);
      assert.ok(!JSON.stringify(err).includes('super-secret-key'), '错误信息不得包含 API key');
      return true;
    },
  );
  assert.equal(count, 1);
});

test('DeepSeek 兼容回退：400 时去掉 stream_options 重试一次', async () => {
  const bodies = [];
  let count = 0;
  const fetchImpl = async (_url, init) => {
    count += 1;
    bodies.push(JSON.parse(init.body));
    if (count === 1) return new Response('stream_options unsupported', { status: 400 });
    return sseResponse(OK_SSE);
  };
  const provider = createDeepseekProvider({ apiKey: 'k', fetchImpl, retryBaseMs: 1 });
  const result = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(count, 2);
  assert.ok(bodies[0].stream_options, '首次请求带 stream_options');
  assert.equal(bodies[1].stream_options, undefined, '回退请求不带 stream_options');
  assert.equal(result.message.content, '你好');
});

test('DeepSeek 非流式回退：stream:false 走 JSON，并同样回调 onDelta', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.stream, false);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '  非流式',
              reasoning_content: '思考',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'catalog.list_skus', arguments: '{"limit":1}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 6, reasoning_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const provider = createDeepseekProvider({ apiKey: 'k', fetchImpl });
  const deltas = [];
  const result = await provider.chat({ messages: [{ role: 'user', content: 'hi' }], stream: false, onDelta: (d) => deltas.push(d) });
  assert.equal(result.message.content, '  非流式');
  assert.equal(result.message.reasoning_content, '思考');
  assert.equal(result.message.tool_calls[0].function.arguments, '{"limit":1}');
  assert.deepEqual(result.usage, { prompt_tokens: 5, completion_tokens: 6, reasoning_tokens: 2 });
  assert.deepEqual(deltas.map((d) => d.type), ['reasoning', 'content']);
});

test('DeepSeek 无 API key：明确报错，不发起请求', async () => {
  let count = 0;
  const provider = createDeepseekProvider({ apiKey: '', fetchImpl: async () => { count += 1; } });
  await assert.rejects(
    () => provider.chat({ messages: [] }),
    (err) => {
      assert.equal(err.code, 'UPSTREAM_LLM_ERROR');
      assert.match(err.message, /LLM_API_KEY/);
      return true;
    },
  );
  assert.equal(count, 0);
});

test('mock provider：确定性回放（同一输入 → 同一输出），usage 固定可断言', async () => {
  const messages = [{ role: 'user', content: '哪些需要补货？' }];
  const a = createMockProvider();
  const b = createMockProvider();
  const outA = await a.chat({ messages });
  const outB = await b.chat({ messages });
  assert.equal(outA.message.content, outB.message.content);
  assert.deepEqual(outA.message.tool_calls, outB.message.tool_calls);
  assert.deepEqual(outA.usage, { ...MOCK_USAGE });
  assert.equal(outA.message.tool_calls[0].function.name, 'catalog.list_skus');
});

test('mock provider：审批意图走 commit 剧本，可完全离线回放', async () => {
  const approvalMeta = { meta: { approval: { id: 'apr_9' } } };
  const messages = [
    { role: 'user', content: '建草稿' },
    {
      role: 'tool',
      name: 'order.create_draft',
      content: JSON.stringify({ ok: true, data: { draft_id: 'draft_9', items: [], total_qty: 1 }, ...approvalMeta }),
    },
    { role: 'assistant', content: '已生成草稿，请审批' },
    { role: 'user', content: '已批准，提交' },
  ];
  const provider = createMockProvider();
  const out = await provider.chat({ messages });
  assert.equal(out.message.tool_calls[0].function.name, 'order.commit');
  const args = JSON.parse(out.message.tool_calls[0].function.arguments);
  assert.deepEqual(args, { draft_id: 'draft_9', approval_id: 'apr_9' });
});

test('createProvider 工厂：mock / deepseek，均满足 Provider 抽象', () => {
  const mock = createProvider({ llm: { provider: 'mock' } });
  assert.equal(mock.name, 'mock');
  assert.equal(mock.supportsStreaming, true);
  assert.equal(typeof mock.chat, 'function');

  const deepseek = createProvider({ llm: { provider: 'deepseek', apiKey: 'k', model: 'deepseek-flash' } });
  assert.equal(deepseek.name, 'deepseek');
  assert.equal(deepseek.model, 'deepseek-flash');

  const fromEnv = createProvider({ LLM_PROVIDER: 'mock' });
  assert.equal(fromEnv.name, 'mock');

  assert.throws(() => createProvider({ LLM_PROVIDER: 'nope' }), /未知 LLM provider/);
});
