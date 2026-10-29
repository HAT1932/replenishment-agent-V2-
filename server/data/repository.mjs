/**
 * repository.mjs — SQLite 仓储（唯一数据访问层）
 * ---------------------------------------------------------------------------
 * 约定：
 *  - 返回**数据库形状**（snake_case），不在这里做业务加工；业务在 queries / domain / agent。
 *  - 审批是**人工闸门**：草稿与审批 1:1，提交必须校验审批已通过（幂等：draft_id 唯一）。
 *  - 审计表 append-only；payload 落库前截断，避免把整页数据写进日志。
 */
import { randomUUID } from 'node:crypto';
import { getSeedEndDate } from './db.mjs';
import { DomainError } from '../domain/errors.mjs';
import { formulaText, PROVENANCE, resolvePlanConfig, resolveSafetyStockConfig } from '../domain/plans.mjs';

export { openDb, seedDatabase } from './db.mjs';

const JSON_PARSE = (text, fallback) => {
  try {
    return text === null || text === undefined ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
};

const nowIso = () => new Date().toISOString();
const pad4 = (n) => String(n).padStart(4, '0');

/* -------------------------------------------------------------------------- */
/*  元数据                                                                     */
/* -------------------------------------------------------------------------- */

export function getSeedDate(db) {
  return getSeedEndDate(db);
}

export function listStores(db) {
  return db.prepare('SELECT * FROM stores ORDER BY id').all();
}

export function listSuppliers(db) {
  return db.prepare('SELECT * FROM suppliers ORDER BY id').all();
}

export function getMeta(db) {
  const today = getSeedDate(db);
  const stores = listStores(db);
  const plans = listPlans(db);
  const categories = db.prepare('SELECT DISTINCT category FROM skus ORDER BY category').all().map((r) => r.category);
  const counts = {
    store: stores.length,
    sku: db.prepare('SELECT COUNT(*) AS c FROM skus').get().c,
    supplier: db.prepare('SELECT COUNT(*) AS c FROM suppliers').get().c,
    sales_days: db.prepare('SELECT COUNT(DISTINCT date) AS c FROM sales').get().c,
    sales_rows: db.prepare('SELECT COUNT(*) AS c FROM sales').get().c,
    pending_drafts: db.prepare("SELECT COUNT(*) AS c FROM drafts WHERE status='draft'").get().c,
    pending_approvals: db.prepare("SELECT COUNT(*) AS c FROM approvals WHERE status='pending'").get().c,
    sessions: db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c,
    audit_events: db.prepare('SELECT COUNT(*) AS c FROM audit').get().c,
  };
  const perSkuDays = db
    .prepare('SELECT COUNT(DISTINCT date) AS n FROM sales')
    .get().n;
  const skuWithGaps = db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT sku_id, COUNT(DISTINCT date) AS k FROM sales GROUP BY sku_id
       ) WHERE k < ?`,
    )
    .get(perSkuDays).c;
  const staleSnapshots = db
    .prepare('SELECT COUNT(*) AS c FROM inventory WHERE snapshot_date < ?')
    .get(today).c;
  const oversold = db
    .prepare('SELECT COUNT(*) AS c FROM inventory WHERE on_hand - locked < 0')
    .get().c;

  return {
    today,
    stores,
    suppliers: listSuppliers(db),
    categories,
    plans,
    safety_config: getSafetyConfig(db),
    holidays: listHolidays(db),
    schedules: listSchedules(db),
    counts,
    data_quality: {
      skus_with_missing_days: skuWithGaps,
      skus_with_stale_snapshot: staleSnapshots,
      skus_oversold: oversold,
      note: '演示数据刻意植入「缺日 / 过期快照 / 超卖」三类脏数据，用于验证口径与新鲜度闸门',
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  SKU / 库存 / 销量                                                           */
/* -------------------------------------------------------------------------- */

export function listSkus(db, { store_id, category, keyword, limit } = {}) {
  const where = [];
  const params = [];
  if (store_id !== undefined && store_id !== null && store_id !== '') {
    where.push('s.store_id = ?');
    params.push(Number(store_id));
  }
  if (category) {
    where.push('s.category = ?');
    params.push(String(category));
  }
  if (keyword) {
    where.push('(s.name LIKE ? OR s.code LIKE ? OR s.sku_no LIKE ? OR s.spec LIKE ?)');
    const like = `%${keyword}%`;
    params.push(like, like, like, like);
  }
  const sql =
    `SELECT s.*, st.name AS store_name, st.warehouse_code AS warehouse_code
     FROM skus s JOIN stores st ON st.id = s.store_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.id
     ${limit ? 'LIMIT ?' : ''}`;
  if (limit) params.push(Number(limit));
  return db.prepare(sql).all(...params);
}

export function getSkuByCode(db, skuCode) {
  if (!skuCode) return null;
  return (
    db
      .prepare(
        `SELECT s.*, st.name AS store_name, st.warehouse_code AS warehouse_code
         FROM skus s JOIN stores st ON st.id = s.store_id WHERE s.code = ?`,
      )
      .get(String(skuCode)) ?? null
  );
}

export function getSkuById(db, id) {
  return (
    db
      .prepare(
        `SELECT s.*, st.name AS store_name, st.warehouse_code AS warehouse_code
         FROM skus s JOIN stores st ON st.id = s.store_id WHERE s.id = ?`,
      )
      .get(Number(id)) ?? null
  );
}

export function getInventory(db, skuId) {
  return db.prepare('SELECT * FROM inventory WHERE sku_id = ?').get(Number(skuId)) ?? null;
}

export function getSales(db, skuId, { from, to } = {}) {
  const params = [Number(skuId)];
  let sql = 'SELECT date, qty, outbound_type FROM sales WHERE sku_id = ?';
  if (from) {
    sql += ' AND date >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND date <= ?';
    params.push(to);
  }
  sql += ' ORDER BY date, outbound_type';
  return db.prepare(sql).all(...params).map((r) => ({ ...r, qty: Number(r.qty) }));
}

/* -------------------------------------------------------------------------- */
/*  预警配置 / 节假日                                                           */
/* -------------------------------------------------------------------------- */

export function getSafetyConfig(db) {
  const row = db.prepare('SELECT * FROM safety_config WHERE id = 1').get();
  if (!row) return resolveSafetyStockConfig({});
  return resolveSafetyStockConfig({
    mode: row.mode,
    lower_fixed: row.lower_fixed,
    upper_fixed: row.upper_fixed,
    min_sellable_days: row.min_sellable_days,
    max_sellable_days: row.max_sellable_days,
  });
}

export function saveSafetyConfig(db, patch = {}) {
  const merged = resolveSafetyStockConfig({ ...getSafetyConfig(db), ...patch });
  db.prepare(
    `UPDATE safety_config SET mode=?, lower_fixed=?, upper_fixed=?, min_sellable_days=?, max_sellable_days=? WHERE id=1`,
  ).run(merged.mode, merged.lower_fixed, merged.upper_fixed, merged.min_sellable_days, merged.max_sellable_days);
  return getSafetyConfig(db);
}

export function listHolidays(db) {
  return db.prepare('SELECT date, name FROM holidays ORDER BY date').all();
}

export function getHolidayDates(db) {
  return listHolidays(db).map((h) => h.date);
}

export function addHoliday(db, { date, name } = {}) {
  if (!date) throw new DomainError('VALIDATION_ERROR', 'date 必填');
  db.prepare('INSERT OR REPLACE INTO holidays (date, name) VALUES (?, ?)').run(String(date), String(name ?? '节假日'));
  return listHolidays(db);
}

export function removeHoliday(db, date) {
  db.prepare('DELETE FROM holidays WHERE date = ?').run(String(date));
  return listHolidays(db);
}

/* -------------------------------------------------------------------------- */
/*  方案                                                                       */
/* -------------------------------------------------------------------------- */

function decoratePlan(row) {
  if (!row) return null;
  const config = resolvePlanConfig(JSON_PARSE(row.config_json, {}));
  return {
    plan_id: row.plan_id,
    plan_name: row.plan_name,
    plan_type: row.plan_type,
    creator: row.creator,
    created_time: row.created_time,
    remark: row.remark,
    is_system: Boolean(row.is_system),
    config,
    formula_text: formulaText(config),
    provenance: PROVENANCE[row.plan_type] ?? 'enhancement',
  };
}

export function listPlans(db) {
  return db
    .prepare('SELECT * FROM plans ORDER BY is_system DESC, plan_id ASC')
    .all()
    .map(decoratePlan);
}

export function getPlan(db, planId) {
  return decoratePlan(db.prepare('SELECT * FROM plans WHERE plan_id = ?').get(Number(planId)));
}

export function createPlan(db, payload = {}) {
  const config = resolvePlanConfig(payload.config ?? payload);
  const name = String(payload.plan_name ?? '').trim();
  if (!name) throw new DomainError('VALIDATION_ERROR', 'plan_name 必填');
  const info = db
    .prepare(
      `INSERT INTO plans (plan_name, plan_type, config_json, creator, created_time, remark, is_system)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(name, config.plan_type, JSON.stringify(config), String(payload.creator ?? '当前用户'), `${getSeedDate(db)} 00:00:00`, String(payload.remark ?? ''));
  return getPlan(db, info.lastInsertRowid);
}

export function updatePlan(db, planId, payload = {}) {
  const existing = getPlan(db, planId);
  if (!existing) throw new DomainError('NOT_FOUND', `方案 ${planId} 不存在`);
  const config = resolvePlanConfig({ ...existing.config, ...(payload.config ?? payload) });
  const name = String(payload.plan_name ?? existing.plan_name);
  db.prepare('UPDATE plans SET plan_name=?, plan_type=?, config_json=?, remark=? WHERE plan_id=?').run(
    name,
    config.plan_type,
    JSON.stringify(config),
    String(payload.remark ?? existing.remark ?? ''),
    Number(planId),
  );
  return getPlan(db, planId);
}

export function deletePlan(db, planId) {
  const existing = getPlan(db, planId);
  if (!existing) throw new DomainError('NOT_FOUND', `方案 ${planId} 不存在`);
  if (existing.is_system) {
    throw new DomainError('CONFLICT', '系统默认方案可修改但不可删除（与有赞后台一致）', { plan_id: existing.plan_id });
  }
  db.prepare('DELETE FROM plans WHERE plan_id = ?').run(Number(planId));
  return { deleted: true, plan_id: Number(planId) };
}

/* -------------------------------------------------------------------------- */
/*  会话 / 消息 / 产物                                                          */
/* -------------------------------------------------------------------------- */

export function createSession(db, { title } = {}) {
  const id = `sess_${randomUUID()}`;
  const ts = nowIso();
  db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    id,
    String(title ?? '补货会话'),
    ts,
    ts,
  );
  return getSession(db, id);
}

export function getSession(db, id) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(String(id));
  if (!row) return null;
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM messages WHERE session_id=?) AS messages,
              (SELECT COUNT(*) FROM artifacts WHERE session_id=?) AS artifacts,
              (SELECT COUNT(*) FROM approvals WHERE session_id=? AND status='pending') AS pending_approvals`,
    )
    .get(row.id, row.id, row.id);
  return { ...row, ...counts };
}

export function listSessions(db, { limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) AS message_count,
              (SELECT content_json FROM messages m WHERE m.session_id=s.id ORDER BY seq DESC LIMIT 1) AS last_message_json
       FROM sessions s ORDER BY s.updated_at DESC LIMIT ?`,
    )
    .all(Number(limit))
    .map((r) => {
      const last = JSON_PARSE(r.last_message_json, null);
      return {
        ...r,
        last_message_json: undefined,
        last_message: last?.text ?? last?.content ?? null,
      };
    });
}

export function deleteSession(db, id) {
  const exists = db.prepare('SELECT id FROM sessions WHERE id = ?').get(String(id));
  if (!exists) throw new DomainError('NOT_FOUND', `会话 ${id} 不存在`);
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(String(id));
  db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(String(id));
  db.prepare('DELETE FROM sessions WHERE id = ?').run(String(id));
  return { deleted: true, session_id: String(id) };
}

export function touchSession(db, id, title) {
  db.prepare('UPDATE sessions SET updated_at=?, title=COALESCE(?, title) WHERE id=?').run(nowIso(), title ?? null, String(id));
}

export function appendMessage(db, { session_id, role, content }) {
  if (!session_id) throw new DomainError('VALIDATION_ERROR', 'session_id 必填');
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM messages WHERE session_id=?').get(String(session_id)).s ?? 0) + 1;
  db.prepare('INSERT INTO messages (session_id, seq, role, content_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
    String(session_id),
    seq,
    String(role),
    JSON.stringify(content ?? {}),
    nowIso(),
  );
  touchSession(db, session_id);
  return { id: seq, session_id, seq, role, content };
}

export function listMessages(db, sessionId) {
  return db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC')
    .all(String(sessionId))
    .map((r) => ({
      id: r.id,
      session_id: r.session_id,
      seq: r.seq,
      role: r.role,
      content: JSON_PARSE(r.content_json, {}),
      created_at: r.created_at,
    }));
}

export function saveArtifact(db, { session_id, kind, title, content, id }) {
  const artifactId = id ?? `art_${randomUUID()}`;
  db.prepare('INSERT OR REPLACE INTO artifacts (id, session_id, kind, title, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    artifactId,
    session_id ?? null,
    String(kind),
    String(title ?? ''),
    JSON.stringify(content ?? {}),
    nowIso(),
  );
  return getArtifact(db, artifactId);
}

export function getArtifact(db, id) {
  const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(String(id));
  if (!row) return null;
  return { ...row, content: JSON_PARSE(row.content_json, {}), content_json: undefined };
}

export function listArtifacts(db, sessionId) {
  return db
    .prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC')
    .all(String(sessionId))
    .map((r) => ({ ...r, content: JSON_PARSE(r.content_json, {}), content_json: undefined }));
}

/* -------------------------------------------------------------------------- */
/*  审批                                                                       */
/* -------------------------------------------------------------------------- */

export function createApproval(db, { session_id, draft_id, kind = 'order_commit', summary, risk = 'medium', requested_by = 'agent' }) {
  const id = `apr_${randomUUID()}`;
  db.prepare(
    `INSERT INTO approvals (id, session_id, draft_id, kind, summary_json, risk, status, requested_at, requested_by)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(id, session_id ?? null, draft_id ?? null, String(kind), JSON.stringify(summary ?? {}), String(risk), nowIso(), String(requested_by));
  return getApproval(db, id);
}

export function getApproval(db, id) {
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(String(id));
  if (!row) return null;
  return {
    ...row,
    summary: JSON_PARSE(row.summary_json, {}),
    summary_json: undefined,
  };
}

export function listApprovals(db, { session_id, status, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (session_id) {
    where.push('session_id = ?');
    params.push(String(session_id));
  }
  if (status) {
    where.push('status = ?');
    params.push(String(status));
  }
  const sql = `SELECT * FROM approvals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY requested_at DESC LIMIT ?`;
  params.push(Number(limit));
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({ ...r, summary: JSON_PARSE(r.summary_json, {}), summary_json: undefined }));
}

export function resolveApproval(db, id, { decision, note = '', operator = '人工' } = {}) {
  const approval = getApproval(db, id);
  if (!approval) throw new DomainError('NOT_FOUND', `审批 ${id} 不存在`);
  if (approval.status !== 'pending') {
    throw new DomainError('CONFLICT', `审批 ${id} 已处理（${approval.status}），不能重复处理`);
  }
  if (!['approve', 'reject'].includes(decision)) {
    throw new DomainError('VALIDATION_ERROR', `decision 需为 approve|reject，收到 ${decision}`);
  }
  const status = decision === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE approvals SET status=?, resolved_at=?, resolved_by=?, note=? WHERE id=?').run(
    status,
    nowIso(),
    String(operator),
    String(note ?? ''),
    String(id),
  );
  if (approval.draft_id) {
    db.prepare('UPDATE drafts SET status=? WHERE id=? AND status=?').run(
      status === 'approved' ? 'approved' : 'rejected',
      approval.draft_id,
      'draft',
    );
  }
  return getApproval(db, id);
}

/* -------------------------------------------------------------------------- */
/*  草稿 / 正式单                                                               */
/* -------------------------------------------------------------------------- */

export function createOrderDraft(db, { kind = 'purchase', items = [], expected_arrival, remark, session_id, created_by = 'agent' }) {
  if (!['purchase', 'apply'].includes(kind)) {
    throw new DomainError('VALIDATION_ERROR', `kind 需为 purchase|apply，收到 ${kind}`);
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'items 不能为空');
  }
  const normalized = items.map((it) => {
    const sku = getSkuByCode(db, it.sku_code);
    if (!sku) throw new DomainError('NOT_FOUND', `SKU ${it.sku_code} 不存在`);
    const qty = Number(it.apply_num ?? it.suggest_num);
    if (!Number.isFinite(qty) || qty < 0) {
      throw new DomainError('VALIDATION_ERROR', `SKU ${it.sku_code} 的 apply_num 非法：${it.apply_num}`);
    }
    const unitCost = Number(it.unit_cost ?? sku.cost_price) || 0;
    const amount = Math.round(qty * unitCost * 100) / 100;
    return {
      sku_id: sku.id,
      sku_code: sku.code,
      sku_no: sku.sku_no,
      product_name: sku.name,
      spec: sku.spec,
      unit: sku.unit,
      supplier_code: sku.supplier_code,
      supplier_name: sku.supplier_name,
      store_id: sku.store_id,
      apply_num: qty,
      unit_cost: unitCost,
      amount,
      tax_rate: Number(sku.tax_rate) || 0,
      tax_amount: Math.round(amount * (Number(sku.tax_rate) || 0) * 100) / 100,
      avg_daily_sales: it.avg_daily_sales ?? null,
      suggest_num: it.suggest_num ?? null,
      provenance: it.provenance ?? null,
      assumptions: it.assumptions ?? [],
    };
  });
  const totalQty = normalized.reduce((a, b) => a + b.apply_num, 0);
  const totalAmount = Math.round(normalized.reduce((a, b) => a + b.amount, 0) * 100) / 100;
  const id = `draft_${randomUUID()}`;
  db.prepare(
    `INSERT INTO drafts (id, kind, items_json, expected_arrival, remark, status, session_id, created_by, created_at, total_qty, total_amount)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
  ).run(id, kind, JSON.stringify(normalized), expected_arrival ?? null, String(remark ?? ''), session_id ?? null, String(created_by), nowIso(), totalQty, totalAmount);
  return getDraft(db, id);
}

export function getDraft(db, id) {
  const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(String(id));
  if (!row) return null;
  return {
    ...row,
    items: JSON_PARSE(row.items_json, []),
    items_json: undefined,
    total_qty: Number(row.total_qty) || 0,
    total_amount: Number(row.total_amount) || 0,
  };
}

export function listDrafts(db, { status, kind, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(String(status));
  }
  if (kind) {
    where.push('kind = ?');
    params.push(String(kind));
  }
  const sql = `SELECT * FROM drafts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  params.push(Number(limit));
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({ ...r, items: JSON_PARSE(r.items_json, []), items_json: undefined }));
}

function nextBizNo(db, kind, date) {
  const prefix = kind === 'purchase' ? 'CG' : 'YH';
  const compact = String(date).replace(/-/g, '');
  const like = `${prefix}${compact}%`;
  const row = db.prepare('SELECT COUNT(*) AS c FROM orders WHERE biz_no LIKE ?').get(like);
  return `${prefix}${compact}${pad4((row?.c ?? 0) + 1)}`;
}

/** 提交草稿（幂等；必须携带已通过的审批） */
export function commitDraft(db, id, { approval_id, operator = '人工' } = {}) {
  const draft = getDraft(db, id);
  if (!draft) throw new DomainError('NOT_FOUND', `草稿 ${id} 不存在`);
  if (draft.status === 'committed') {
    const existing = db.prepare('SELECT * FROM orders WHERE draft_id = ?').get(String(id));
    return { ...existing, items: JSON_PARSE(existing?.items_json, []), idempotent: true };
  }
  if (draft.status !== 'approved') {
    throw new DomainError('APPROVAL_REQUIRED', `草稿状态为 ${draft.status}，未通过审批不能提交`, { draft_id: id });
  }
  if (!approval_id) {
    throw new DomainError('APPROVAL_REQUIRED', '缺少 approval_id：提交必须携带人工审批');
  }
  const approval = getApproval(db, approval_id);
  if (!approval) throw new DomainError('NOT_FOUND', `审批 ${approval_id} 不存在`);
  if (approval.status !== 'approved') {
    throw new DomainError('APPROVAL_REQUIRED', `审批状态为 ${approval.status}，不能提交`);
  }
  if (approval.draft_id !== draft.id) {
    throw new DomainError('APPROVAL_REQUIRED', '审批与草稿不匹配');
  }

  const orderId = `ord_${randomUUID()}`;
  const date = getSeedDate(db);
  const bizNo = nextBizNo(db, draft.kind, date);
  db.prepare(
    `INSERT INTO orders (id, kind, biz_no, items_json, expected_arrival, remark, status, draft_id, session_id, created_by, created_at, total_qty, total_amount)
     VALUES (?, ?, ?, ?, ?, ?, '待审核', ?, ?, ?, ?, ?, ?)`,
  ).run(orderId, draft.kind, bizNo, draft.items_json ?? JSON.stringify(draft.items), draft.expected_arrival, draft.remark, draft.id, draft.session_id, String(operator), nowIso(), draft.total_qty, draft.total_amount);
  db.prepare('UPDATE drafts SET status=?, committed_order_id=? WHERE id=?').run('committed', orderId, draft.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  return { ...order, items: JSON_PARSE(order.items_json, []), items_json: undefined, idempotent: false };
}

export function listOrders(db, { kind, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (kind) {
    where.push('kind = ?');
    params.push(String(kind));
  }
  const sql = `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  params.push(Number(limit));
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({ ...r, items: JSON_PARSE(r.items_json, []), items_json: undefined }));
}

/* -------------------------------------------------------------------------- */
/*  审计                                                                       */
/* -------------------------------------------------------------------------- */

const PAYLOAD_LIMIT = 2048;

export function appendAudit(db, { session_id, actor = 'agent', kind, tool, payload, ok = true, duration_ms, provenance }) {
  let payloadJson = null;
  if (payload !== undefined && payload !== null) {
    // 字符串超长先截断，保证落库内容始终是**合法 JSON**（否则读取端只能拿到 null）
    const raw = typeof payload === 'string' && payload.length > 1200 ? `${payload.slice(0, 1200)}…` : payload;
    const text = JSON.stringify(raw);
    payloadJson =
      text.length > PAYLOAD_LIMIT
        ? JSON.stringify({ truncated: true, preview: text.slice(0, PAYLOAD_LIMIT - 64) })
        : text;
  }
  const info = db
    .prepare(
      `INSERT INTO audit (ts, session_id, actor, kind, tool, payload_json, ok, duration_ms, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(nowIso(), session_id ?? null, String(actor), String(kind), tool ?? null, payloadJson, ok ? 1 : 0, duration_ms ?? null, provenance ?? null);
  return Number(info.lastInsertRowid);
}

export function searchAudit(db, { session_id, kind, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (session_id) {
    where.push('session_id = ?');
    params.push(String(session_id));
  }
  if (kind) {
    where.push('kind = ?');
    params.push(String(kind));
  }
  const sql = `SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  params.push(Number(limit));
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({
      ...r,
      payload: JSON_PARSE(r.payload_json, null),
      payload_json: undefined,
      ok: Boolean(r.ok),
    }));
}

/* -------------------------------------------------------------------------- */
/*  调度                                                                       */
/* -------------------------------------------------------------------------- */

export function listSchedules(db) {
  return db.prepare('SELECT * FROM schedules ORDER BY id').all().map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
}

export function getSchedule(db, id) {
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(String(id));
  return row ? { ...row, enabled: Boolean(row.enabled) } : null;
}

export function markScheduleRun(db, id, { next_run_at } = {}) {
  db.prepare('UPDATE schedules SET last_run_at=?, next_run_at=COALESCE(?, next_run_at) WHERE id=?').run(nowIso(), next_run_at ?? null, String(id));
  return getSchedule(db, id);
}

export function createRun(db, { schedule_id, started_at, finished_at, draft_ids, summary, ok }) {
  const id = `run_${randomUUID()}`;
  db.prepare('INSERT INTO runs (id, schedule_id, started_at, finished_at, draft_ids_json, summary_json, ok) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    schedule_id ?? null,
    started_at ?? nowIso(),
    finished_at ?? nowIso(),
    JSON.stringify(draft_ids ?? []),
    JSON.stringify(summary ?? {}),
    ok ? 1 : 0,
  );
  return id;
}

export function listRuns(db, { schedule_id, limit = 20 } = {}) {
  const params = [];
  let sql = 'SELECT * FROM runs';
  if (schedule_id) {
    sql += ' WHERE schedule_id = ?';
    params.push(String(schedule_id));
  }
  sql += ' ORDER BY started_at DESC LIMIT ?';
  params.push(Number(limit));
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({ ...r, draft_ids: JSON_PARSE(r.draft_ids_json, []), summary: JSON_PARSE(r.summary_json, {}), ok: Boolean(r.ok) }));
}
