/**
 * reseed.mjs — 重建演示数据（必须先在 Windows 上停掉占用 db 的进程）
 * 用法：npm run seed  （或 node scripts/reseed.mjs）
 * 行为：删除 DB 三件套 → 重新打开（openDb 发现空库会自动播种）
 */
import { rmSync } from 'node:fs';
import { loadConfig } from '../server/config.mjs';
import { openDb } from '../server/data/db.mjs';
import { todayStr } from '../server/data/seed.mjs';

const { dbPath } = loadConfig();
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(dbPath + suffix, { force: true });
  } catch (error) {
    console.error(`无法删除 ${dbPath}${suffix}：${error.message}`);
    console.error('请先停止服务（Ctrl+C）再重试。');
    process.exit(1);
  }
}

const db = openDb(dbPath, { endDate: todayStr() });
const counts = {
  stores: db.prepare('SELECT COUNT(*) AS c FROM stores').get().c,
  skus: db.prepare('SELECT COUNT(*) AS c FROM skus').get().c,
  sales: db.prepare('SELECT COUNT(*) AS c FROM sales').get().c,
  days: db.prepare('SELECT COUNT(DISTINCT date) AS c FROM sales').get().c,
  plans: db.prepare('SELECT COUNT(*) AS c FROM plans').get().c,
};
console.log(`已重建：${dbPath}`);
console.log(
  `门店 ${counts.stores} / SKU ${counts.skus} / 销量行 ${counts.sales}（${counts.days} 天）/ 方案 ${counts.plans}`,
);
db.close();
