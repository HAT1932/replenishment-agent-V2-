/**
 * Pager.tsx — 分页条（共 N 条 / 每页选择 / 上一下一页 / 跳至）
 * 与官方截图 (05_*.png) 的分页语义对齐；总数优先用服务端返回的 total。
 */
import { useState } from 'react';

export interface PagerProps {
  page: number;
  pageSize: number;
  /** 服务端总数；缺失时传 -1 表示「未知」，只显示页码 */
  total: number;
  totalPages?: number;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
  pageSizeOptions?: number[];
  disabled?: boolean;
}

export function Pager({
  page,
  pageSize,
  total,
  totalPages,
  onPage,
  onPageSize,
  pageSizeOptions = [10, 20, 50, 100],
  disabled = false,
}: PagerProps) {
  const [jump, setJump] = useState('');

  const computedTotalPages =
    totalPages && totalPages > 0
      ? totalPages
      : total > 0
        ? Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
        : 1;

  const canPrev = !disabled && page > 1;
  const canNext = !disabled && page < computedTotalPages;

  const doJump = () => {
    const target = Number.parseInt(jump, 10);
    setJump('');
    if (!Number.isFinite(target)) return;
    const next = Math.min(Math.max(1, target), computedTotalPages);
    if (next !== page) onPage(next);
  };

  return (
    <nav className="ra-pager" aria-label="分页">
      <span>
        {total >= 0 ? (
          <>
            共 <b>{total}</b> 条
          </>
        ) : (
          '分页'
        )}
      </span>

      {onPageSize ? (
        <label className="ra-field">
          <span>每页</span>
          <select
            className="ra-select"
            value={pageSize}
            onChange={(event) => onPageSize(Number(event.target.value))}
            style={{ width: 78 }}
            aria-label="每页条数"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size} 条
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="ra-faint">每页 {pageSize} 条</span>
      )}

      <span className="ra-right" />

      <button type="button" className="ra-btn ra-btn-sm" disabled={!canPrev} onClick={() => onPage(page - 1)}>
        上一页
      </button>
      <span className="ra-pager-pos">
        {page} / {computedTotalPages}
      </span>
      <button type="button" className="ra-btn ra-btn-sm" disabled={!canNext} onClick={() => onPage(page + 1)}>
        下一页
      </button>

      <label className="ra-field">
        <span>跳至</span>
        <input
          className="ra-input"
          style={{ width: 52, textAlign: 'center' }}
          value={jump}
          inputMode="numeric"
          onChange={(event) => setJump(event.target.value.replace(/[^\d]/g, ''))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') doJump();
          }}
          onBlur={doJump}
          aria-label="跳转到指定页"
        />
        <span>页</span>
      </label>
    </nav>
  );
}
