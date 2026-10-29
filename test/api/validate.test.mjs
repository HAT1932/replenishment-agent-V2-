/**
 * test/api/validate.test.mjs — 手写校验器与错误信封的单元测试
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ApiError,
  STATUS_BY_CODE,
  normalizeError,
  redact,
  sendError,
} from '../../server/http/respond.mjs';
import * as V from '../../server/http/validate.mjs';

/** 断言抛出 VALIDATION_ERROR 且 details.fields[0].field 匹配 */
function expectValidation(fn, field) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, '没有抛错');
  assert.equal(thrown.code, 'VALIDATION_ERROR');
  assert.equal(thrown.status, 400);
  assert.equal(thrown.details.fields[0].field, field);
  return thrown;
}

test('日期：严格日历日（含闰年与非法日）', () => {
  assert.equal(V.isValidDateString('2026-01-15'), true);
  assert.equal(V.isValidDateString('2024-02-29'), true); // 闰年
  assert.equal(V.isValidDateString('2026-02-29'), false); // 平年
  assert.equal(V.isValidDateString('2026-02-31'), false);
  assert.equal(V.isValidDateString('2026-13-01'), false);
  assert.equal(V.isValidDateString('2026-1-5'), false);
  assert.equal(V.isValidDateString('2026/01/15'), false);
  assert.equal(V.isValidDateString(''), false);
  assert.equal(V.isValidDateString(null), false);
  assert.equal(V.isValidDateString(20260115), false);

  expectValidation(() => V.assertDate('2026-02-31', 'as_of'), 'as_of');
  expectValidation(() => V.assertDate('abc', 'as_of'), 'as_of');
  expectValidation(() => V.assertDate(undefined, 'as_of', { required: true }), 'as_of');
  assert.equal(V.assertDate(undefined, 'as_of'), undefined);
  assert.equal(V.assertDate('2026-01-15', 'as_of', { required: true }), '2026-01-15');
});

test('字符串：trim / 必填 / 长度 / 正则', () => {
  assert.equal(V.assertString('  hi  ', 'q'), 'hi');
  assert.equal(V.assertString(undefined, 'q'), undefined);
  assert.equal(V.assertString(undefined, 'q', { default: 'x' }), 'x');
  expectValidation(() => V.assertString(undefined, 'q', { required: true }), 'q');
  expectValidation(() => V.assertString(123, 'q', { required: true }), 'q');
  expectValidation(() => V.assertString('', 'q', { required: true }), 'q');
  expectValidation(() => V.assertString('abcdef', 'q', { max: 3 }), 'q');
  expectValidation(() => V.assertString('ab', 'q', { min: 3 }), 'q');
  expectValidation(() => V.assertId('bad id!', 'session_id'), 'session_id');
  assert.equal(V.assertId('sess_000001', 'session_id'), 'sess_000001');
});

test('整数：查询串数字字符串可解析，越界/小数被拒', () => {
  assert.equal(V.assertInt('42', 'limit'), 42);
  assert.equal(V.assertInt('-3', 'limit'), -3);
  assert.equal(V.assertInt(7, 'limit'), 7);
  assert.equal(V.assertInt(undefined, 'limit'), undefined);
  assert.equal(V.assertInt(undefined, 'limit', { default: 100 }), 100);
  expectValidation(() => V.assertInt('4.2', 'limit'), 'limit');
  expectValidation(() => V.assertInt('abc', 'limit'), 'limit');
  expectValidation(() => V.assertInt(0, 'limit', { min: 1 }), 'limit');
  expectValidation(() => V.assertInt(999, 'limit', { max: 500 }), 'limit');
});

test('数字 / 布尔 / 枚举', () => {
  assert.equal(V.assertNumber('1.25', 'coefficient'), 1.25);
  expectValidation(() => V.assertNumber('x', 'coefficient'), 'coefficient');

  assert.equal(V.assertBoolean('true', 'only_low'), true);
  assert.equal(V.assertBoolean('1', 'only_low'), true);
  assert.equal(V.assertBoolean('false', 'only_low'), false);
  assert.equal(V.assertBoolean('0', 'only_low'), false);
  assert.equal(V.assertBoolean(1, 'only_low'), true);
  assert.equal(V.assertBoolean(undefined, 'only_low', { default: false }), false);
  expectValidation(() => V.assertBoolean('yes', 'only_low'), 'only_low');

  assert.equal(V.assertEnum('approve', 'decision', ['approve', 'reject'], { required: true }), 'approve');
  expectValidation(() => V.assertEnum('maybe', 'decision', ['approve', 'reject'], { required: true }), 'decision');
  assert.equal(V.assertEnum(undefined, 'status', ['a', 'b'], { default: 'a' }), 'a');
});

test('数组 / 对象 / 分页', () => {
  assert.deepEqual(V.assertArray([1, 2], 'items'), [1, 2]);
  assert.deepEqual(
    V.assertArray(['1', '2'], 'items', { item: (item) => Number(item) }),
    [1, 2],
  );
  expectValidation(() => V.assertArray('nope', 'items', { required: true }), 'items');
  expectValidation(() => V.assertArray([], 'items', { required: true, min: 1 }), 'items');

  assert.deepEqual(V.assertObject({ a: 1 }, 'body'), { a: 1 });
  expectValidation(() => V.assertObject([1], 'body', { required: true }), 'body');
  expectValidation(() => V.assertObject(null, 'body', { required: true }), 'body');

  const params = new URLSearchParams('page=3&page_size=25');
  assert.deepEqual(V.assertPagination(params), { page: 3, page_size: 25 });
  assert.deepEqual(V.assertPagination(new URLSearchParams()), { page: 1, page_size: 50 });
  expectValidation(() => V.assertPagination(new URLSearchParams('page_size=0')), 'page_size');
  expectValidation(() => V.assertPagination(new URLSearchParams('page_size=500')), 'page_size');
  assert.equal(V.assertLimit(undefined), 100);
  assert.equal(V.assertLimit('200'), 200);
});

test('请求体 JSON 解析：空体 → {}，坏 JSON/数组 → VALIDATION_ERROR', () => {
  assert.deepEqual(V.parseJsonBody(''), {});
  assert.deepEqual(V.parseJsonBody('   '), {});
  assert.deepEqual(V.parseJsonBody('{"a":1}'), { a: 1 });
  expectValidation(() => V.parseJsonBody('{oops'), 'body');
  expectValidation(() => V.parseJsonBody('[1,2]'), 'body');
  expectValidation(() => V.parseJsonBody('"str"'), 'body');
  expectValidation(() => V.parseJsonBody('null'), 'body');
});

test('错误码 → 状态码映射与信封形状（契约 §6）', () => {
  assert.deepEqual(STATUS_BY_CODE, {
    VALIDATION_ERROR: 400,
    NOT_FOUND: 404,
    APPROVAL_REQUIRED: 409,
    CONFLICT: 409,
    DATA_MISSING: 422,
    STALE_DATA: 422,
    UPSTREAM_LLM_ERROR: 502,
    INTERNAL: 500,
  });

  for (const [code, status] of Object.entries(STATUS_BY_CODE)) {
    const normalized = normalizeError(new ApiError(code, '测试'));
    assert.equal(normalized.code, code);
    assert.equal(normalized.status, status);
  }

  // 未知 code → INTERNAL，且不回显堆栈
  const unknown = normalizeError(Object.assign(new Error('boom'), { stack: 'SECRET_STACK' }));
  assert.equal(unknown.code, 'INTERNAL');
  assert.equal(unknown.message, '服务器内部错误');
  assert.ok(!JSON.stringify(unknown).includes('SECRET_STACK'));

  // 契约内 code 的普通错误对象（DomainError 形状）被原样识别
  const domainLike = normalizeError(Object.assign(new Error('销量缺失'), {
    code: 'DATA_MISSING',
    details: { sku_code: 'SKU-001' },
  }));
  assert.equal(domainLike.code, 'DATA_MISSING');
  assert.equal(domainLike.status, 422);
  assert.equal(domainLike.details.sku_code, 'SKU-001');
});

test('脱敏：key / Authorization / .env 行都不会出现在错误与日志里', () => {
  const key = 'sk-abcdef1234567890';
  const samples = [
    `请求头错误 Authorization: Bearer ${key}`,
    `LLM_API_KEY=${key}`,
    `{"api_key":"${key}"}`,
    `apiKey: ${key}`,
  ];
  for (const sample of samples) {
    const masked = redact(sample);
    assert.ok(!masked.includes(key), `未脱敏：${sample} → ${masked}`);
    assert.match(masked, /\*\*\*/);
  }
});

test('sendError：信封为 { ok:false, error:{ code, message } }', () => {
  const headers = new Map();
  let ended = null;
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    end(body) {
      ended = body;
    },
  };
  const normalized = sendError(res, new ApiError('NOT_FOUND', '不存在'));
  assert.equal(res.statusCode, 404);
  assert.equal(normalized.code, 'NOT_FOUND');
  const payload = JSON.parse(ended.toString('utf8'));
  assert.deepEqual(Object.keys(payload), ['ok', 'error']);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'NOT_FOUND');
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  assert.ok(!JSON.stringify(payload).includes('stack'));
});
