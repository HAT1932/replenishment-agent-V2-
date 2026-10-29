/**
 * DataTable.tsx — 数据表（排序 / 勾选 / 四态 / 分页协作 / a11y）
 *
 * 四态：hover（CSS）、排序（aria-sort + <button> 表头）、选中、空态（整行占位文案）。
 * 无障碍：排序表头是真正的 <button>，`aria-sort` 标在 <th> 上（契约 §7 / 任务硬性纪律）。
 * 排序只作用于**当前页数据**（服务端分页时不做跨页排序，避免误导）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: string;
  dir: SortDir;
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** 表头第二行小字（如「上限 / 下限」） */
  subHeader?: ReactNode;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  /** 排序取值；提供后该列可参与排序 */
  sortValue?: (row: T) => string | number | null | undefined;
  render: (row: T, index: number) => ReactNode;
  className?: string;
  width?: number | string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowClassName?: (row: T, index: number) => string | undefined;
  selectable?: boolean;
  selectedKeys?: ReadonlySet<string>;
  onSelectionChange?: (next: Set<string>) => void;
  /** 受控排序；不传则组件内部维护 */
  sort?: SortState | null;
  defaultSort?: SortState | null;
  onSortChange?: (next: SortState | null) => void;
  loading?: boolean;
  emptyText?: ReactNode;
  dense?: boolean;
  caption?: string;
  onRowClick?: (row: T) => void;
  /** 表格最小宽度（触发横向滚动） */
  minWidth?: number;
}

function alignClass(align?: 'left' | 'right' | 'center'): string {
  if (align === 'right') return 'ra-cell-right';
  if (align === 'center') return 'ra-cell-center';
  return '';
}

function compareValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): number {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1; // 空值恒排最后
  if (bEmpty) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'zh-CN');
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowClassName,
  selectable = false,
  selectedKeys,
  onSelectionChange,
  sort,
  defaultSort = null,
  onSortChange,
  loading = false,
  emptyText = '暂无数据',
  dense = false,
  caption,
  onRowClick,
  minWidth,
}: DataTableProps<T>) {
  const allCheckboxRef = useRef<HTMLInputElement>(null);
  const [innerSort, setInnerSort] = useState<SortState | null>(defaultSort);
  const controlledSort = sort !== undefined;
  const activeSort = controlledSort ? sort ?? null : innerSort;

  const sortedRows = useMemo(() => {
    if (!activeSort) return rows;
    const column = columns.find((col) => col.key === activeSort.key);
    if (!column || !column.sortValue) return rows;
    const getValue = column.sortValue;
    const factor = activeSort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => compareValues(getValue(a), getValue(b)) * factor);
  }, [rows, columns, activeSort]);

  const keys = useMemo(() => sortedRows.map((row) => rowKey(row)), [sortedRows, rowKey]);
  const keySet = useMemo(() => new Set(keys), [keys]);

  const selectedCount = useMemo(() => {
    if (!selectedKeys) return 0;
    let count = 0;
    for (const key of keySet) if (selectedKeys.has(key)) count += 1;
    return count;
  }, [keySet, selectedKeys]);

  const allChecked = keys.length > 0 && selectedCount === keys.length;
  const someChecked = selectedCount > 0 && !allChecked;

  useEffect(() => {
    if (allCheckboxRef.current) allCheckboxRef.current.indeterminate = someChecked;
  }, [someChecked]);

  const applySort = (key: string) => {
    const column = columns.find((col) => col.key === key);
    if (!column?.sortable || !column.sortValue) return;

    let next: SortState | null;
    if (!activeSort || activeSort.key !== key) next = { key, dir: 'asc' };
    else if (activeSort.dir === 'asc') next = { key, dir: 'desc' };
    else next = null;

    if (!controlledSort) setInnerSort(next);
    onSortChange?.(next);
  };

  const toggleAll = () => {
    if (!onSelectionChange) return;
    const next = new Set(selectedKeys ?? []);
    if (allChecked) {
      for (const key of keySet) next.delete(key);
    } else {
      for (const key of keySet) next.add(key);
    }
    onSelectionChange(next);
  };

  const toggleOne = (key: string) => {
    if (!onSelectionChange) return;
    const next = new Set(selectedKeys ?? []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  };

  const columnCount = columns.length + (selectable ? 1 : 0);

  return (
    <div className="ra-table-wrap">
      <table
        className={`ra-table${dense ? ' ra-table-dense' : ''}`}
        style={minWidth ? { minWidth } : undefined}
      >
        {caption ? <caption className="ra-sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {selectable ? (
              <th className="ra-cell-check" scope="col">
                <input
                  ref={allCheckboxRef}
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleAll}
                  aria-label={allChecked ? '取消全选当前页' : '全选当前页'}
                />
              </th>
            ) : null}

            {columns.map((column) => {
              const isActive = activeSort?.key === column.key;
              const ariaSort = isActive
                ? activeSort.dir === 'asc'
                  ? 'ascending'
                  : 'descending'
                : 'none';
              const sortable = Boolean(column.sortable && column.sortValue);
              const cls = [alignClass(column.align), sortable ? 'ra-th-sortable' : '', column.className ?? '']
                .filter(Boolean)
                .join(' ');

              return (
                <th
                  key={column.key}
                  scope="col"
                  className={cls || undefined}
                  aria-sort={sortable ? ariaSort : undefined}
                  style={column.width ? { width: column.width } : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className="ra-th-btn"
                      data-active={isActive}
                      onClick={() => applySort(column.key)}
                    >
                      <span>
                        {column.header}
                        {column.subHeader ? <span className="ra-th-sub">{column.subHeader}</span> : null}
                      </span>
                      <span className="ra-sort-arrow" aria-hidden="true">
                        {isActive ? (activeSort.dir === 'asc' ? '▲' : '▼') : '⇅'}
                      </span>
                    </button>
                  ) : (
                    <>
                      {column.header}
                      {column.subHeader ? <span className="ra-th-sub">{column.subHeader}</span> : null}
                    </>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && sortedRows.length === 0 ? (
            <tr>
              <td colSpan={columnCount}>
                <div className="ra-table-loading">
                  <span className="ra-spinner" aria-hidden="true" /> 正在加载…
                </div>
              </td>
            </tr>
          ) : sortedRows.length === 0 ? (
            <tr>
              <td colSpan={columnCount}>
                <div className="ra-table-empty" role="status">
                  {emptyText}
                </div>
              </td>
            </tr>
          ) : (
            sortedRows.map((row, index) => {
              const key = rowKey(row);
              const selected = selectedKeys?.has(key) ?? false;
              const extra = rowClassName?.(row, index);
              const className = [
                selected ? 'ra-row-selected' : '',
                extra ?? '',
                onRowClick ? 'ra-row-clickable' : '',
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <tr
                  key={key}
                  className={className || undefined}
                  aria-selected={selectable ? selected : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                >
                  {selectable ? (
                    <td className="ra-cell-check">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleOne(key)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`选择第 ${index + 1} 行`}
                      />
                    </td>
                  ) : null}
                  {columns.map((column) => (
                    <td key={column.key} className={alignClass(column.align) || undefined}>
                      {column.render(row, index)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
