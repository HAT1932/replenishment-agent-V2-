/**
 * AssumptionsPage.tsx — #/assumptions 假设登记（H1–H8）
 *
 * 这是「provenance 可追溯」的落点：任何标记 assumption 的数字都能在这里
 * 查到假设内容 / 置信度 / 翻盘影响 / 验证方式。Citation strip 的红色 chip 直接跳这里。
 */
import { useId, useMemo, useState } from 'react';
import { apiGet } from '../../lib/api';
import { useAsyncData } from '../../lib/hooks';
import type { Assumption } from '../../app/types';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState, InlineAlert } from '../../components/States';
import { DASH } from '../../lib/format';

function confidenceTone(confidence: string | undefined): string {
  const text = (confidence ?? '').toLowerCase();
  if (text === 'high' || text === 'medium-high') return 'ra-tag-ok';
  if (text === 'medium') return 'ra-tag-warn';
  if (text === 'high-risk') return 'ra-tag-danger';
  if (text === 'low') return 'ra-tag-danger';
  return 'ra-tag-gray';
}

const CONFIDENCE_LABEL: Record<string, string> = {
  high: '高',
  'medium-high': '中高',
  medium: '中',
  low: '低',
  'high-risk': '高风险',
};

export function AssumptionsPage() {
  const searchId = useId();
  const filterId = useId();
  const [keyword, setKeyword] = useState('');
  const [confidence, setConfidence] = useState('');

  const state = useAsyncData<Assumption[]>(
    async (signal) => {
      const payload = await apiGet<{ assumptions?: Assumption[] } | Assumption[]>(
        '/assumptions',
        undefined,
        signal,
      );
      if (Array.isArray(payload)) return payload;
      return payload?.assumptions ?? [];
    },
    [],
  );

  const all = state.data ?? [];

  const rows = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    return all.filter((item) => {
      if (confidence !== '' && (item.confidence ?? '') !== confidence) return false;
      if (text === '') return true;
      const haystack = [item.id, item.statement, item.evidence, item.risk, item.probe]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(text);
    });
  }, [all, keyword, confidence]);

  const columns: Column<Assumption>[] = [
    {
      key: 'id',
      header: '编号',
      sortable: true,
      sortValue: (row) => row.id,
      render: (row) => <span className="ra-assumption-id">{row.id}</span>,
    },
    {
      key: 'statement',
      header: '假设内容',
      render: (row) => <div className="ra-assumption-stmt">{row.statement}</div>,
      sortable: true,
      sortValue: (row) => row.statement,
    },
    {
      key: 'confidence',
      header: '置信度',
      align: 'center',
      sortable: true,
      sortValue: (row) => row.confidence ?? '',
      render: (row) => (
        <span className={`ra-tag ${confidenceTone(row.confidence)}`}>
          {CONFIDENCE_LABEL[row.confidence ?? ''] ?? row.confidence ?? DASH}
        </span>
      ),
    },
    {
      key: 'risk',
      header: '翻盘影响',
      render: (row) => <div className="ra-assumption-meta">{row.risk ?? DASH}</div>,
    },
    {
      key: 'evidence',
      header: '证据',
      render: (row) => <div className="ra-assumption-meta">{row.evidence ?? DASH}</div>,
    },
    {
      key: 'probe',
      header: '验证方式',
      render: (row) => <div className="ra-assumption-meta">{row.probe ?? DASH}</div>,
    },
  ];

  return (
    <div className="ra-page">
      <div className="ra-page-head">
        <div>
          <div className="ra-page-title">假设登记 H1–H8</div>
          <div className="ra-page-sub">
            每个数字的「未证实假设」都能在这里追溯：假设内容 → 置信度 → 翻盘影响 → 验证方式。
          </div>
        </div>
      </div>

      <div className="ra-mb-3">
        <InlineAlert tone="info">
          标记为 <b>assumption</b> 的数值意味着结论依赖未证实前提（例如建议数量用 ceil、统计窗口 15 天）。
          假设一旦翻盘，受影响建议需要重算。
        </InlineAlert>
      </div>

      <div className="ra-card">
        <div className="ra-toolbar">
          <label className="ra-field" htmlFor={searchId}>
            <span>搜索</span>
            <input
              id={searchId}
              className="ra-input"
              placeholder="假设内容 / 证据 / 验证方式"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              style={{ width: 260 }}
            />
          </label>
          <label className="ra-field" htmlFor={filterId}>
            <span>置信度</span>
            <select
              id={filterId}
              className="ra-select"
              value={confidence}
              onChange={(event) => setConfidence(event.target.value)}
              style={{ width: 130 }}
            >
              <option value="">全部</option>
              {Array.from(new Set(all.map((item) => item.confidence).filter(Boolean))).map((value) => (
                <option key={String(value)} value={String(value)}>
                  {CONFIDENCE_LABEL[String(value)] ?? String(value)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ra-btn ra-btn-link"
            onClick={() => {
              setKeyword('');
              setConfidence('');
            }}
          >
            重置筛选条件
          </button>
          <span className="ra-right ra-faint ra-xs">
            共 {rows.length} / {all.length} 条
          </span>
        </div>

        {state.error ? (
          <ErrorState message={state.error} onRetry={state.reload} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={state.loading}
            minWidth={980}
            emptyText={
              all.length === 0
                ? '服务端未返回假设登记（ASSUMPTIONS）。'
                : '没有匹配的假设，换个关键词试试。'
            }
            caption="假设登记表"
          />
        )}
      </div>
    </div>
  );
}
