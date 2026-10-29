/**
 * scheduler.mjs — 定时/事件触发的「巡店补货」（Auto 入口）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 *
 * 契约（contracts §5）：
 *   runDueSchedules({ db, runtime, now }) -> { runs:[...] }
 *   computeNextRun(cadence, from) -> iso
 *
 * 硬约束：
 *  1) Auto 入口**永不自动提交**：只生成草稿 + 审批请求，提交必须人工；
 *  2) 数据过期的 SKU 不进自动草稿（contracts §0 硬规则 4）；
 *  3) 每一步都写审计（actor='scheduler'），并且通知物化在返回值里（由 HTTP/UI 决定怎么展示）；
 *  4) 时间一律显式传入（`now`），不在模块内部读系统时钟。
 *
 * cadence 支持三种（contracts §4 #12 的 cadence 字段）：
 *   - `hourly`          每小时整点
 *   - `daily@HH:mm`     每天 HH:mm（默认按 UTC+8 解释，可 opts.tzOffsetMinutes 覆盖）
 *   - `every:30m`       固定间隔（m=分钟 / h=小时 / d=天 / s=秒）
 */
/** cadence 里 daily@HH:mm 的默认时区（与 config.tzOffset '+08:00' 一致） */
export const TZ_OFFSET_MINUTES = 480;

export const CADENCE_KINDS = Object.freeze(['hourly', 'daily', 'every']);

function invalid(message) {
  const err = new Error(message);
  err.code = 'VALIDATION_ERROR';
  return err;
}

/** 解析 cadence 字符串（严格校验，避免静默变成"永不触发"） */
export function parseCadence(cadence) {
  if (typeof cadence !== 'string' || !cadence.trim()) {
    throw invalid('cadence 必须是非空字符串（hourly | daily@HH:mm | every:30m）');
  }
  const text = cadence.trim().toLowerCase();
  if (text === 'hourly') return { kind: 'hourly', raw: cadence };
  let m = /^daily@([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (m) return { kind: 'daily', hour: Number(m[1]), minute: Number(m[2]), raw: cadence };
  m = /^every:(\d+)([smhd])$/.exec(text);
  if (m) {
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
    const amount = Number(m[1]);
    if (!Number.isFinite(amount) || amount <= 0) throw invalid(`every 的间隔必须为正数：${cadence}`);
    return { kind: 'every', intervalMs: amount * unitMs, raw: cadence };
  }
  throw invalid(`无法识别的 cadence：${cadence}（支持 hourly | daily@HH:mm | every:30m）`);
}

function toDate(from) {
  if (from instanceof Date) {
    if (Number.isNaN(from.getTime())) throw invalid('from 不是合法时间');
    return new Date(from.getTime());
  }
  if (typeof from === 'number') return new Date(from);
  if (typeof from === 'string') {
    const d = new Date(from);
    if (Number.isNaN(d.getTime())) throw invalid(`from 不是合法时间：${from}`);
    return d;
  }
  throw invalid('from 必须是 Date / ISO 字符串 / 毫秒时间戳');
}

/**
 * 计算下一次运行时间（严格晚于 from）。
 * @param {string} cadence
 * @param {Date|string|number} [from]
 * @param {{tzOffsetMinutes?: number}} [opts]
 * @returns {string} ISO 8601（UTC）
 */
export function computeNextRun(cadence, from = new Date(), opts = {}) {
  const parsed = parseCadence(cadence);
  const base = toDate(from);
  const tz = Number.isFinite(opts.tzOffsetMinutes) ? opts.tzOffsetMinutes : TZ_OFFSET_MINUTES;

  if (parsed.kind === 'hourly') {
    const next = new Date(base.getTime());
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next.toISOString();
  }
  if (parsed.kind === 'every') {
    return new Date(base.getTime() + parsed.intervalMs).toISOString();
  }
  // daily@HH:mm：把 from 平移到目标时区，取当天 HH:mm；不晚于 from 则顺延一天
  const shifted = new Date(base.getTime() + tz * 60_000);
  const candidate = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    parsed.hour,
    parsed.minute,
    0,
    0,
  ) - tz * 60_000;
  const nextMs = candidate > base.getTime() ? candidate : candidate + 86_400_000;
  return new Date(nextMs).toISOString();
}

function nowIso(now) {
  return toDate(now).toISOString();
}

function compactStamp(now) {
  return nowIso(now).replace(/[-:.TZ]/g, '').slice(0, 14);
}

function todayOf(now, tzOffsetMinutes) {
  const shifted = new Date(toDate(now).getTime() + tzOffsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

async function safeAudit(db, repository, event) {
  if (typeof repository?.appendAudit !== 'function') return null;
  try {
    return await repository.appendAudit(db, {
      actor: 'scheduler',
      ok: true,
      duration_ms: 0,
      ...event,
    });
  } catch {
    return null;
  }
}

/**
 * 跑一个定时任务：建议 → 过滤过期 → 草稿 → 审批 → 审计 → 通知（永不提交）。
 * @param {{db: unknown, tools: any, repository: any, domain: any, schedule: object,
 *          now?: Date|string|number, tzOffsetMinutes?: number}} input
 */
export async function runScheduleOnce({
  db,
  tools,
  repository,
  domain,
  schedule,
  now = new Date(),
  tzOffsetMinutes = TZ_OFFSET_MINUTES,
}) {
  if (!tools || typeof tools.execute !== 'function') {
    throw invalid('runScheduleOnce 需要 tools 注册表（createToolRegistry 的返回值）');
  }
  const scheduleId = schedule?.id ?? schedule?.schedule_id ?? null;
  const scheduleName = schedule?.name ?? scheduleId ?? '未命名任务';
  const tz = Number.isFinite(schedule?.tz_offset_minutes) ? schedule.tz_offset_minutes : tzOffsetMinutes;
  const asOf = todayOf(now, tz);
  const runId = `run_${scheduleId ?? 'adhoc'}_${compactStamp(now)}`;
  const ctx = { db, sessionId: schedule?.session_id ?? null, actor: 'scheduler' };

  const result = {
    run_id: runId,
    schedule_id: scheduleId,
    schedule_name: scheduleName,
    plan_id: schedule?.plan_id ?? null,
    as_of: asOf,
    draft_ids: [],
    approval_ids: [],
    notifications: [],
    skipped: [],
    summary: '',
    ok: true,
    error: null,
  };

  // 1) 计算建议（确定性工具，不经 LLM）
  const suggestion = await tools.execute(
    'suggestion.compute',
    {
      plan_id: schedule?.plan_id ?? undefined,
      store_id: schedule?.store_id ?? undefined,
      category: schedule?.category ?? undefined,
      as_of: asOf,
      expected_arrival: schedule?.expected_arrival ?? undefined,
      only_low: schedule?.only_low ?? true,
    },
    ctx,
  );

  if (!suggestion.ok) {
    result.ok = false;
    result.error = suggestion.error;
    result.summary = `巡店补货失败：${suggestion.error?.code ?? 'INTERNAL'} ${suggestion.error?.message ?? ''}`.trim();
    await safeAudit(db, repository, {
      session_id: schedule?.session_id ?? null,
      kind: 'schedule_run',
      tool: 'schedule.run',
      payload: { schedule_id: scheduleId, run_id: runId, ok: false, error: result.error },
      ok: false,
      provenance: 'assumption',
    });
    await markRun(db, repository, scheduleId, result, now, tz);
    return result;
  }

  const rows = suggestion.data?.rows ?? [];
  // 2) 硬规则 4：过期数据不进自动草稿；建议数量 <=0 也不进
  const eligible = [];
  for (const row of rows) {
    const flags = Array.isArray(row.flags) ? row.flags : [];
    const qty = Number(row.apply_num ?? row.suggest_num ?? 0);
    if (flags.includes('stale_data')) {
      result.skipped.push({ sku_code: row.sku_code, reason: 'stale_data', staleness_days: row.demand_window?.staleness_days ?? null });
      continue;
    }
    if (!(qty > 0)) {
      result.skipped.push({ sku_code: row.sku_code, reason: 'no_suggestion' });
      continue;
    }
    eligible.push({ sku_code: row.sku_code, apply_num: Math.trunc(qty) });
  }

  if (!eligible.length) {
    result.summary = `巡店补货：无可自动补货 SKU（${rows.length} 行中 ${result.skipped.length} 行被过滤）`;
    await safeAudit(db, repository, {
      session_id: schedule?.session_id ?? null,
      kind: 'schedule_run',
      tool: 'schedule.run',
      payload: { schedule_id: scheduleId, run_id: runId, eligible: 0, skipped: result.skipped.length },
      ok: true,
      provenance: 'documented',
    });
    await markRun(db, repository, scheduleId, result, now, tz);
    return result;
  }

  // 3) 生成草稿（只生成草稿，需人工审批后提交）
  const draftResp = await tools.execute(
    'order.create_draft',
    {
      kind: 'purchase',
      items: eligible,
      expected_arrival: schedule?.expected_arrival ?? rows[0]?.expected_arrival ?? undefined,
      remark: `定时任务「${scheduleName}」自动生成，等待审批`,
    },
    ctx,
  );
  if (!draftResp.ok) {
    result.ok = false;
    result.error = draftResp.error;
    result.summary = `巡店补货生成草稿失败：${draftResp.error?.code ?? 'INTERNAL'}`;
    await safeAudit(db, repository, {
      session_id: schedule?.session_id ?? null,
      kind: 'schedule_run',
      tool: 'schedule.run',
      payload: { schedule_id: scheduleId, run_id: runId, ok: false, error: result.error },
      ok: false,
      provenance: 'assumption',
    });
    await markRun(db, repository, scheduleId, result, now, tz);
    return result;
  }

  const draftId = draftResp.data?.draft_id ?? null;
  const approvalId = draftResp.data?.approval?.id ?? null;
  if (draftId) result.draft_ids.push(draftId);
  if (approvalId) result.approval_ids.push(approvalId);
  result.summary =
    `巡店补货：${eligible.length} 个 SKU 生成草稿 ${draftId ?? '（未返回）'}，` +
    `合计 ${draftResp.data?.total_qty ?? 0} 件 / ${draftResp.data?.total_amount ?? 0} 元，等待人工审批`;
  result.notifications.push({
    channel: 'inbox',
    level: 'info',
    title: `巡店补货待审：${scheduleName}`,
    body: result.summary,
    ref: { draft_id: draftId, approval_id: approvalId, run_id: runId },
  });

  // 下一次运行时间提前算好（失败/重启也不会永久卡在到期）
  try {
    result.next_run_at = schedule?.cadence ? computeNextRun(schedule.cadence, now, { tzOffsetMinutes: tz }) : null;
  } catch {
    result.next_run_at = null;
  }

  // 4) 审计（actor=scheduler 的任务级事件；工具级审计由 registry 已写）
  await safeAudit(db, repository, {
    session_id: schedule?.session_id ?? null,
    kind: 'schedule_run',
    tool: 'schedule.run',
    payload: {
      schedule_id: scheduleId,
      run_id: runId,
      draft_id: draftId,
      approval_id: approvalId,
      eligible_count: eligible.length,
      skipped: result.skipped.slice(0, 20),
      as_of: asOf,
    },
    ok: true,
    provenance: 'assumption',
  });

  // 5) 永不自动提交：这里刻意不调用 order.commit
  await markRun(db, repository, scheduleId, result, now, tz);
  return result;
}

/** 记录运行结果并推进 next_run_at（数据层字段名容错；失败不影响主流程） */
async function markRun(db, repository, scheduleId, result, now, tz) {
  if (!scheduleId) return;
  const nextRunAt = result.next_run_at ?? null;
  try {
    if (typeof repository?.markScheduleRun === 'function') {
      await repository.markScheduleRun(db, scheduleId, { next_run_at: nextRunAt });
    }
  } catch {
    /* 数据层未就绪/签名差异：不阻断补货结果 */
  }
  // 运行历史（GET /api/schedules 可能展示最近一次运行）；失败不影响主流程
  try {
    if (typeof repository?.createRun === 'function') {
      await repository.createRun(db, {
        schedule_id: scheduleId,
        started_at: result.started_at ?? nowIso(now),
        finished_at: nowIso(now),
        draft_ids: result.draft_ids ?? [],
        ok: result.ok !== false,
        summary: {
          run_id: result.run_id,
          summary: result.summary,
          approval_ids: result.approval_ids ?? [],
          skipped: result.skipped ?? [],
          notifications: result.notifications ?? [],
        },
      });
    }
  } catch {
    /* 同上 */
  }
}

/**
 * 扫描所有到期任务并逐个执行（Auto 入口）。
 *  - `only: [id]` 只处理指定任务；`force: true` 忽略到期时间（HTTP 手动触发用）。
 * @param {{db: unknown, runtime?: object, tools?: any, repository?: any, domain?: any,
 *          now?: Date|string|number, only?: string[], force?: boolean}} input
 */
export async function runDueSchedules({ db, runtime, tools, repository, domain, now = new Date(), only, force = false }) {
  const registry = tools ?? runtime?.tools ?? null;
  const repo = repository ?? runtime?.repository ?? runtime?.deps?.repository ?? null;
  const dom = domain ?? runtime?.deps?.domain ?? null;
  if (!registry) throw invalid('runDueSchedules 需要 tools（或传入带 tools 的 runtime）');
  if (!repo || typeof repo.listSchedules !== 'function') throw invalid('runDueSchedules 需要数据层 repository.listSchedules');

  const onlySet = Array.isArray(only) && only.length ? new Set(only.map(String)) : null;
  const schedules = (await repo.listSchedules(db)) ?? [];
  const nowMs = toDate(now).getTime();
  const runs = [];
  for (const schedule of schedules) {
    if (schedule.enabled === false) continue;
    const scheduleId = schedule.id ?? schedule.schedule_id ?? null;
    if (onlySet && !onlySet.has(String(scheduleId))) continue;
    const nextAt = schedule.next_run_at ?? schedule.nextAt ?? null;
    if (!nextAt && !force) {
      // 从未运行过：只计算下一次，不在本次偷偷执行（避免启动即触发全量草稿）
      const computed = schedule.cadence ? computeNextRun(schedule.cadence, now) : null;
      runs.push({
        run_id: null,
        schedule_id: scheduleId,
        schedule_name: schedule.name ?? scheduleId,
        ok: true,
        skipped_reason: 'no_next_run_at',
        next_run_at: computed,
        draft_ids: [],
        summary: '首次调度：仅计算下次运行时间，未生成草稿',
      });
      continue;
    }
    if (!force && new Date(nextAt).getTime() > nowMs) continue;
    const run = await runScheduleOnce({ db, tools: registry, repository: repo, domain: dom, schedule, now });
    runs.push(run);
  }
  return { runs, checked: schedules.length, now: nowIso(now) };
}

/**
 * 手动触发指定任务（HTTP `POST /api/schedules/:id/run` 用）。
 * 与定时执行同一套逻辑：只产草稿 + 审批，永不提交。
 * @param {{db: unknown, runtime: object, scheduleId: string, now?: Date|string|number}} input
 */
export async function triggerSchedule({ db, runtime, scheduleId, now = new Date() }) {
  const registry = runtime?.tools ?? null;
  const repo = runtime?.repository ?? runtime?.deps?.repository ?? null;
  const dom = runtime?.deps?.domain ?? null;
  if (!registry) throw invalid('triggerSchedule 需要带 tools 的 runtime');
  if (!repo || typeof repo.listSchedules !== 'function') throw invalid('triggerSchedule 需要数据层 repository.listSchedules');
  const schedules = (await repo.listSchedules(db)) ?? [];
  const schedule = schedules.find((s) => String(s.id ?? s.schedule_id) === String(scheduleId));
  if (!schedule) {
    const err = new Error(`定时任务不存在：${scheduleId}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  return runScheduleOnce({ db, tools: registry, repository: repo, domain: dom, schedule, now });
}
