/**
 * db.mjs — SQLite 建库/建表/首次播种（node:sqlite，零第三方依赖）
 * ---------------------------------------------------------------------------
 * 设计要点：
 *  1) 单文件库、WAL 模式；`meta.seed_end_date` 是「数据日期」的唯一来源（域层从不读系统时钟）；
 *  2) 表结构按「会话 / 消息 / 产物 / 审批 / 草稿 / 正式单 / 审计 / 调度」划分，
 *     **审计表只增不改**（append-only），审批与草稿 1:1，正式单靠 draft_id 唯一约束保证幂等；
 *  3) 首次打开自动播种演示数据（确定性随机种子，可复现）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildSeedData, todayStr } from './seed.mjs';

export const SCHEMA_VERSION = '2.0.0';

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  warehouse_code TEXT,
  warehouse_name TEXT,
  from_warehouse_code TEXT,
  from_warehouse_name TEXT,
  region TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,
  name TEXT,
  lead_time_days INTEGER
);

CREATE TABLE IF NOT EXISTS skus (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  code TEXT UNIQUE NOT NULL,
  sku_no TEXT,
  name TEXT,
  spec TEXT,
  category TEXT,
  unit TEXT,
  cost_price REAL,
  retail_price REAL,
  tax_rate REAL,
  supplier_id INTEGER REFERENCES suppliers(id),
  supplier_code TEXT,
  supplier_name TEXT,
  status TEXT DEFAULT '在售'
);
CREATE INDEX IF NOT EXISTS idx_skus_store ON skus(store_id);
CREATE INDEX IF NOT EXISTS idx_skus_category ON skus(category);

CREATE TABLE IF NOT EXISTS inventory (
  sku_id INTEGER PRIMARY KEY REFERENCES skus(id),
  on_hand REAL,
  locked REAL DEFAULT 0,
  in_transit REAL DEFAULT 0,
  plan_stock REAL DEFAULT 0,
  snapshot_date TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  date TEXT NOT NULL,
  qty REAL NOT NULL,
  outbound_type TEXT NOT NULL DEFAULT 'sale',
  amount REAL,
  PRIMARY KEY (sku_id, date, outbound_type)
);
CREATE INDEX IF NOT EXISTS idx_sales_sku_date ON sales(sku_id, date);

CREATE TABLE IF NOT EXISTS plans (
  plan_id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_name TEXT NOT NULL,
  plan_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  creator TEXT,
  created_time TEXT,
  remark TEXT,
  is_system INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS safety_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT,
  lower_fixed REAL,
  upper_fixed REAL,
  min_sellable_days INTEGER,
  max_sellable_days INTEGER
);

CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY,
  name TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  kind TEXT,
  title TEXT,
  content_json TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  draft_id TEXT,
  kind TEXT,
  summary_json TEXT,
  risk TEXT,
  status TEXT DEFAULT 'pending',
  requested_at TEXT,
  requested_by TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, requested_at);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  items_json TEXT NOT NULL,
  expected_arrival TEXT,
  remark TEXT,
  status TEXT DEFAULT 'draft',
  session_id TEXT,
  created_by TEXT,
  created_at TEXT,
  committed_order_id TEXT,
  total_qty REAL,
  total_amount REAL
);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status, created_at);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  biz_no TEXT UNIQUE,
  items_json TEXT NOT NULL,
  expected_arrival TEXT,
  remark TEXT,
  status TEXT,
  draft_id TEXT UNIQUE,
  session_id TEXT,
  created_by TEXT,
  created_at TEXT,
  total_qty REAL,
  total_amount REAL
);
CREATE INDEX IF NOT EXISTS idx_orders_kind ON orders(kind, created_at);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT,
  actor TEXT,
  kind TEXT NOT NULL,
  tool TEXT,
  payload_json TEXT,
  ok INTEGER,
  duration_ms REAL,
  provenance TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit(session_id, ts);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT,
  cadence TEXT,
  plan_id INTEGER,
  store_id INTEGER,
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  draft_ids_json TEXT,
  summary_json TEXT,
  ok INTEGER
);
`;

/**
 * 打开数据库；文件不存在则建库建表；表为空则播种。
 * @param {string} dbPath
 * @param {{seed?: boolean, endDate?: string}} [options]
 */
export function openDb(dbPath, options = {}) {
  const { seed = true, endDate } = options;
  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);

  const hasSeed = db.prepare("SELECT value FROM meta WHERE key='seed_end_date'").get();
  if (!hasSeed && seed) {
    seedDatabase(db, buildSeedData({ endDate: endDate ?? todayStr() }));
  }
  return db;
}

/** 写入演示数据（幂等：调用方需保证空库） */
export function seedDatabase(db, data) {
  db.exec('BEGIN');
  try {
    const insertMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    insertMeta.run('seed_end_date', data.endDate);
    insertMeta.run('schema_version', SCHEMA_VERSION);
    insertMeta.run('seeded_at', new Date().toISOString());

    const insertStore = db.prepare(
      `INSERT INTO stores (id, code, name, warehouse_code, warehouse_name, from_warehouse_code, from_warehouse_name, region)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of data.stores) {
      insertStore.run(s.id, s.code, s.name, s.warehouse_code, s.warehouse_name, s.from_warehouse_code, s.from_warehouse_name, s.region);
    }

    const insertSupplier = db.prepare('INSERT INTO suppliers (id, code, name, lead_time_days) VALUES (?, ?, ?, ?)');
    for (const s of data.suppliers) insertSupplier.run(s.id, s.code, s.name, s.lead_time_days);

    const insertSku = db.prepare(
      `INSERT INTO skus (id, store_id, code, sku_no, name, spec, category, unit, cost_price, retail_price,
        tax_rate, supplier_id, supplier_code, supplier_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const k of data.skus) {
      insertSku.run(k.id, k.store_id, k.code, k.sku_no, k.name, k.spec, k.category, k.unit, k.cost_price,
        k.retail_price, k.tax_rate, k.supplier_id, k.supplier_code, k.supplier_name, k.status);
    }

    const insertInv = db.prepare(
      'INSERT INTO inventory (sku_id, on_hand, locked, in_transit, plan_stock, snapshot_date) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const i of data.inventory) {
      insertInv.run(i.sku_id, i.on_hand, i.locked, i.in_transit, i.plan_stock, i.snapshot_date);
    }

    const insertSales = db.prepare(
      'INSERT INTO sales (sku_id, date, qty, outbound_type, amount) VALUES (?, ?, ?, ?, ?)',
    );
    for (const s of data.sales) insertSales.run(s.sku_id, s.date, s.qty, s.outbound_type, s.amount ?? 0);

    const insertPlan = db.prepare(
      `INSERT INTO plans (plan_id, plan_name, plan_type, config_json, creator, created_time, remark, is_system)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of data.plans) {
      insertPlan.run(p.plan_id, p.plan_name, p.plan_type, JSON.stringify(p.config), p.creator, p.created_time, p.remark, p.is_system);
    }

    db.prepare(
      `INSERT INTO safety_config (id, mode, lower_fixed, upper_fixed, min_sellable_days, max_sellable_days)
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(data.safetyConfig.mode, data.safetyConfig.lower_fixed, data.safetyConfig.upper_fixed,
      data.safetyConfig.min_sellable_days, data.safetyConfig.max_sellable_days);

    const insertHoliday = db.prepare('INSERT OR REPLACE INTO holidays (date, name) VALUES (?, ?)');
    for (const h of data.holidays) insertHoliday.run(h.date, h.name);

    const insertSchedule = db.prepare(
      `INSERT INTO schedules (id, name, cadence, plan_id, store_id, enabled, last_run_at, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of data.schedules) {
      insertSchedule.run(s.id, s.name, s.cadence, s.plan_id, s.store_id, s.enabled ? 1 : 0, null, s.next_run_at, data.endDate);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 数据日期（域层的 asOf 默认值来源） */
export function getSeedEndDate(db) {
  return db.prepare("SELECT value FROM meta WHERE key='seed_end_date'").get()?.value ?? todayStr();
}
