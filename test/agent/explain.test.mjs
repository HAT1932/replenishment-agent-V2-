import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExplainMessages,
  buildExplainPayload,
  collectAllowedNumbers,
  deterministicExplanation,
  extractNumbers,
  generateExplanation,
  verifyNumbers,
} from '../../server/agent/explain.mjs';

/** 与 domain 输出一致的 SKU 详情骨架 */
function detailFixture() {
  const suggestion = {
    sku_code: 'SPSH0010009',
    product_name: '伊利纯牛奶',
    spec: '250ml*24盒',
    unit: '箱',
    store_name: '上海静安嘉里中心店',
    as_of: '2026-10-29',
    expected_arrival: '2026-11-05',
    plan_name: '按日均销量补货',
    plan_type: 'avg_daily',
    formula_text: '建议数量 = 近15天日均销量 × 可售天数 + 库存预警下限 − 可售库存',
    formula_expr: '7.6667 × 15 + 53.6667 − -3',
    provenance: 'documented',
    suggest_num: 172,
    suggest_raw: 171.6667,
    suggest_raw_exact: 171.6667,
    terms: { avg_daily_sales_exact: 7.6667, coverage_days: 15, stock_lower_exact: 53.6667, sellable_exact: -3, in_transit_exact: 0 },
    factors: [
      { key: 'demand', name: '需求侧（日均 × 可售天数）', value: 7.6667, unit: '件/天', impact: 115, direction: 'up', detail: '' },
      { key: 'stock_lower', name: '库存预警下限', value: 53.6667, unit: '件', impact: 53.6667, direction: 'up', detail: '' },
      { key: 'sellable', name: '可售库存', value: -3, unit: '件', impact: 3, direction: 'down', detail: '超卖' },
    ],
    factor_identity: { sum: 171.6667, raw: 171.6667, diff: 0, ok: true },
    stock_lower: 53.6667,
    stock_upper: 230,
    avg_daily_sales: 7.6667,
    avg_daily_sales_exact: 7.6667,
    inventory: { on_hand: 2, locked: 5, sellable: -3, in_transit: 0, snapshot_date: '2026-10-29', staleness_days: 0 },
    demand_window: {
      days: 15,
      total: 115,
      recorded_days: 15,
      imputed_days: 0,
      last_recorded_date: '2026-10-29',
      staleness_days: 0,
      scope: 'store',
      include: ['sale', 'transfer'],
    },
    coefficient_enabled: false,
    coefficient: 1,
    coefficient_detail: [],
    guard: { alert: true, policy: 'physical_plus_transit', text: '实物 2 + 在途 0 < 下限 54' },
    confidence: {
      level: 'high',
      label: '🟢 高置信度',
      score: 0.9,
      reasons: ['15/15 天有记录'],
      basis: { recorded_ratio: 1 },
    },
    urgency: { level: 'critical', label: '🔴 缺货高风险', reasons: ['可售为负'], safety_line: 60 },
    anomaly: { types: ['stockout_risk'], items: [{ type: 'stockout_risk', label: '缺货高风险（可售天数 < 前置期）', detail: '' }] },
    assumptions: ['H1', 'H2', 'H4'],
    unit_cost: 45,
    amount: 7740,
  };
  return { detail: { sku: suggestion, suggestions: [suggestion], inventory: suggestion.inventory, as_of: '2026-10-29' }, decision: null };
}

test('buildExplainPayload：抽出factors/置信度/紧急度，且标注口径边界', () => {
  const payload = buildExplainPayload(detailFixture());
  assert.equal(payload.sku_code, 'SPSH0010009');
  assert.equal(payload.suggest_num, 172);
  assert.equal(payload.factors.length, 3);
  assert.match(payload.provenance_boundary, /官方文档口径/);
  assert.equal(payload.confidence.level, 'high');
  assert.equal(payload.urgency.level, 'critical');
});

test('buildExplainPayload：没有建议时抛 DATA_MISSING（不编造）', () => {
  assert.throws(
    () => buildExplainPayload({ detail: { suggestions: [] } }),
    (err) => err.code === 'DATA_MISSING',
  );
});

test('extractNumbers：排除 SKU 编码与日期，保留真实数量', () => {
  const numbers = extractNumbers(
    '伊利纯牛奶（SPSH0010009）建议补 172 箱，550ml*24盒，数据日期 2026-10-29，可售 -3 箱，日均 7.6667 件/天',
  );
  assert.ok(numbers.includes('172'));
  assert.ok(numbers.includes('-3'));
  assert.ok(numbers.includes('7.6667'));
  assert.ok(!numbers.includes('0010009'), 'SKU 编码里的数字不应被当成事实');
  assert.ok(!numbers.includes('2026'));
});

test('verifyNumbers：全部可溯源 → ok；编造数字 → 精确捕获', () => {
  const payload = buildExplainPayload(detailFixture());
  const grounded = '建议补 172 箱，未截断值 171.67，需求侧 115，下限 53.67，可售 -3，日均 7.67。';
  const good = verifyNumbers(grounded, payload);
  assert.equal(good.ok, true, `未通过：${good.unknown.join(',')}`);

  const hallucinated = '建议补 188 箱，因为日均涨到 9.2 件/天。';
  const bad = verifyNumbers(hallucinated, payload);
  assert.equal(bad.ok, false);
  assert.ok(bad.unknown.includes('188'));
  assert.ok(bad.unknown.includes('9.2'));
});

test('verifyNumbers：可推导百分比（记录覆盖率 100%）不应误判', () => {
  const payload = buildExplainPayload(detailFixture());
  const result = verifyNumbers('需求窗口 15 天中 15 天有记录（100%），滞后 0 天。', payload);
  assert.equal(result.ok, true, `未通过：${result.unknown.join(',')}`);
});

test('deterministicExplanation：四段结构齐全且自身可对账', () => {
  const payload = buildExplainPayload(detailFixture());
  const text = deterministicExplanation(payload);
  for (const section of ['【结论】', '【账怎么算的】', '【关键判断】', '【风险与建议】']) {
    assert.ok(text.includes(section), `缺少 ${section}`);
  }
  assert.match(text, /箱/, '应使用 SKU 自身单位');
  assert.match(text, /超卖|可售为负/, '超卖必须提示');
  assert.equal(verifyNumbers(text, payload).ok, true);
});

test('buildExplainMessages：提示词包含硬规则与数据，且禁止自算', () => {
  const payload = buildExplainPayload(detailFixture());
  const messages = buildExplainMessages(payload);
  assert.equal(messages.length, 2);
  const system = messages[0].content;
  assert.match(system, /禁止做任何四则运算/);
  assert.match(system, /官方文档口径/);
  assert.match(system, /【结论】/);
  assert.ok(system.includes('SPSH0010009'), '数据必须注入提示词');
});

test('generateExplanation：模型返回可溯源文本 → source=llm 且对账通过', async () => {
  const payload = buildExplainPayload(detailFixture());
  const provider = {
    name: 'stub',
    model: 'stub-1',
    async chat() {
      return {
        message: { role: 'assistant', content: '【结论】建议补 172 箱，金额 7740 元；需求侧贡献 115，下限 53.67，可售 -3。' },
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      };
    },
  };
  const result = await generateExplanation({ provider, payload });
  assert.equal(result.source, 'llm');
  assert.equal(result.degraded, false);
  assert.equal(result.verification.ok, true);
  assert.equal(result.model, 'stub-1');
});

test('generateExplanation：模型不可用 / 抛错 / 空输出 → 确定性兜底，不崩', async () => {
  const payload = buildExplainPayload(detailFixture());
  const throwing = { name: 'x', model: 'x', async chat() { throw new Error('upstream 500'); } };
  const failed = await generateExplanation({ provider: throwing, payload });
  assert.equal(failed.source, 'deterministic');
  assert.equal(failed.degraded, true);
  assert.match(failed.error ?? '', /upstream 500/);
  assert.ok(failed.text.includes('【结论】'));

  const empty = { name: 'y', model: 'y', async chat() { return { message: { content: '' } }; } };
  const emptyResult = await generateExplanation({ provider: empty, payload });
  assert.equal(emptyResult.source, 'deterministic');

  const none = await generateExplanation({ provider: null, payload });
  assert.equal(none.source, 'deterministic');
  assert.equal(verifyNumbers(none.text, payload).ok, true);
});

test('collectAllowedNumbers：包含负数绝对值与四舍五入变体', () => {
  const payload = { a: -3, b: 171.6667, c: '2026-10-29' };
  const allowed = collectAllowedNumbers(payload);
  assert.ok(allowed.has('3'));
  assert.ok(allowed.has('-3'));
  assert.ok(allowed.has('171.67'));
  assert.ok(!allowed.has('2026'));
});
