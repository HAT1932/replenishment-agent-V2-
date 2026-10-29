/**
 * SchedulesPage.tsx — #/schedules 定时任务（Auto 入口）
 * 「立即运行」调用 POST /api/schedules/:id/run，只产草稿（不会自动提交），结果落审计。
 */
import { useState } from 'react';
import { apiGet, apiPost, errorMessage } from '../../lib/api';
import { useAsyncData } from '../../lib/hooks';
import type { Schedule } from '../../app/types';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState, InlineAlert } from '../../components/States';
import { useToast } from '../../components/Toast';
import { DASH, fmtDateTime } from '../../lib/format';

interface RunResult {
  run_id?: string;
  draft_ids?: string[];
  summary?: string;
  [key: string]: unknown;
}

export function SchedulesPage() {
  const toast = useToast();
  const [running, setRunning] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{ scheduleId: string; result: RunResult } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const state = useAsyncData<Schedule[]>(
    async (signal) => {
      const payload = await apiGet<{ schedules?: Schedule[] } | Schedule[]>('/schedules', undefined, signal);
      if (Array.isArray(payload)) return payload;
      return payload?.schedules ?? [];
    },
    [],
  );

  const schedules = state.data ?? [];

  const run = async (schedule: Schedule) => {
    setRunning(schedule.id);
    setRunError(null);
    setRunResult(null);
    try {
      const result = await apiPost<RunResult>(`/schedules/${encodeURIComponent(schedule.id)}/run`);
      setRunResult({ scheduleId: schedule.id, result: result ?? {} });
      toast(`已触发：${schedule.name ?? schedule.id}（仅生成草稿）`, 'ok');
      state.reload();
    } catch (e: unknown) {
      const message = errorMessage(e);
      setRunError(message);
      toast(`触发失败：${message}`, 'err');
    } finally {
      setRunning(null);
    }
  };

  const columns: Column<Schedule>[] = [
    {
      key: 'name',
      header: '任务名称',
      sortable: true,
      sortValue: (row) => row.name ?? row.id,
      render: (row) => (
        <div className="ra-prod-cell">
          <span className="ra-prod-name">{row.name ?? '（未命名任务）'}</span>
          <span className="ra-prod-meta">{row.id}</span>
        </div>
      ),
    },
    {
      key: 'cadence',
      header: '调度周期',
      render: (row) => <code className="ra-cadence">{row.cadence ?? DASH}</code>,
    },
    {
      key: 'plan_id',
      header: '关联方案',
      render: (row) => <span className="ra-mono ra-xs">{row.plan_id ?? DASH}</span>,
    },
    {
      key: 'enabled',
      header: '启用',
      align: 'center',
      render: (row) => (
        <span className={`ra-tag ${row.enabled === false ? 'ra-tag-gray' : 'ra-tag-ok'}`}>
          {row.enabled === false ? '已停用' : '启用中'}
        </span>
      ),
    },
    {
      key: 'last_run_at',
      header: '上次运行',
      sortable: true,
      sortValue: (row) => row.last_run_at ?? '',
      render: (row) => <span className="ra-muted">{fmtDateTime(row.last_run_at)}</span>,
    },
    {
      key: 'next_run_at',
      header: '下次运行',
      sortable: true,
      sortValue: (row) => row.next_run_at ?? '',
      render: (row) => <span className="ra-muted">{fmtDateTime(row.next_run_at)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      align: 'center',
      render: (row) => (
        <button
          type="button"
          className="ra-btn ra-btn-sm"
          onClick={() => void run(row)}
          disabled={running !== null}
          title="立即运行一次（只生成草稿，永不自动提交）"
        >
          {running === row.id ? <span className="ra-spinner" aria-hidden="true" /> : null}
          立即运行
        </button>
      ),
    },
  ];

  return (
    <div className="ra-page">
      <div className="ra-page-head">
        <div>
          <div className="ra-page-title">定时任务</div>
          <div className="ra-page-sub">
            Auto 入口：到期自动运行，产出待审清单与审计事件；只生成草稿，永不自动提交。
          </div>
        </div>
        <div className="ra-page-actions">
          <button type="button" className="ra-btn ra-btn-sm" onClick={state.reload} disabled={state.loading}>
            刷新
          </button>
        </div>
      </div>

      {runError ? (
        <InlineAlert tone="danger">触发失败：{runError}</InlineAlert>
      ) : null}

      {runResult ? (
        <div className="ra-mb-3">
          <InlineAlert tone="ok">
            <div>
              <b>运行完成</b> · 任务 {runResult.scheduleId}
              {runResult.result.run_id ? ` · run ${runResult.result.run_id}` : ''}
            </div>
            {runResult.result.summary ? <div className="ra-mt-2">{runResult.result.summary}</div> : null}
            {runResult.result.draft_ids && runResult.result.draft_ids.length > 0 ? (
              <div className="ra-mt-2">
                新增草稿：{runResult.result.draft_ids.join('、')}（去 #/drafts 查看并审批）
              </div>
            ) : (
              <div className="ra-mt-2">本次没有生成草稿。</div>
            )}
          </InlineAlert>
        </div>
      ) : null}

      <div className="ra-card">
        {state.error ? (
          <ErrorState message={state.error} onRetry={state.reload} />
        ) : (
          <DataTable
            columns={columns}
            rows={schedules}
            rowKey={(row) => row.id}
            loading={state.loading}
            emptyText="还没有定时任务。可由后端 seed 提供默认任务，或通过接口创建。"
            caption="定时任务列表"
          />
        )}
      </div>
    </div>
  );
}
