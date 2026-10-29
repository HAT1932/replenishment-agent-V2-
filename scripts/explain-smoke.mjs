/** 冒烟：真实模型生成解释（含数值对账）+ What-if 确定性重算 */
process.env.DB_PATH = process.env.DB_PATH || 'data/explain-smoke.db';
process.env.PORT = process.env.PORT || '3232';
import { rmSync } from 'node:fs';
if (!process.env.KEEP_DB) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(process.env.DB_PATH + suffix, { force: true });
}
const { createServer } = await import('../server/index.mjs');
const app = await createServer();
await app.listen(Number(process.env.PORT), '127.0.0.1');
const base = app.url;
const post = async (path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const wb = await (await fetch(`${base}/api/workbench?page_size=1`)).json();
const sku = wb.data.rows[0].sku_code;
console.log('SKU:', sku, '| 建议:', wb.data.rows[0].suggest_num, '| 风险:', wb.data.rows[0].risk_level);

const t0 = Date.now();
const ex = await post('/api/explain', { sku_code: sku });
console.log(`\n=== /api/explain ${ex.status}（${((Date.now() - t0) / 1000).toFixed(1)}s）===`);
if (ex.status !== 200) {
  console.log(JSON.stringify(ex.body).slice(0, 400));
} else {
  const e = ex.body.data.explanation;
  console.log('source:', e.source, '| model:', e.model, '| degraded:', e.degraded);
  console.log('对账:', JSON.stringify(e.verification));
  console.log('--- 解释正文 ---\n' + e.text);
  console.log('\n--- grounding ---');
  console.log('factors:', ex.body.data.grounding.factors.map((f) => `${f.name}${f.impact >= 0 ? '+' : ''}${f.impact}`).join(' | '));
  console.log('confidence:', ex.body.data.grounding.confidence?.label, '| urgency:', ex.body.data.grounding.urgency?.label);
  console.log('anomaly:', (ex.body.data.grounding.anomaly ?? []).map((a) => a.label).join(';') || '无');
}

const wi = await post('/api/whatif', { sku_code: sku, overrides: { purchase_cycle_days: 5 } });
console.log(`\n=== /api/whatif ${wi.status} ===`);
if (wi.status !== 200) {
  console.log(JSON.stringify(wi.body).slice(0, 300));
} else {
  const d = wi.body.data;
  console.log('before:', d.before.suggest_num, '→ after:', d.after.suggest_num, '| delta:', d.delta.qty, `(${d.delta.qty_pct}%)`);
  console.log('factor_delta:', d.factor_delta.map((f) => `${f.name} ${f.before}→${f.after}`).join(' | '));
  console.log('notes:', d.notes[0]);
}
const bad = await post('/api/whatif', { sku_code: sku, overrides: { magic: 1 } });
console.log('\n非法覆盖:', bad.status, bad.body.error?.code, bad.body.error?.message?.slice(0, 60));

await app.close();
