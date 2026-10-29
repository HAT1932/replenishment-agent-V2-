/**
 * SuggestionsPage.tsx — #/suggestions 非会话直查页
 *
 * 复用 SuggestionsPanel（同一套 9 列表 / 只读建议数量 / 可编辑采购数量 / Δ 徽标）。
 * 筛选完全走服务端（契约 §6 GET /api/suggestions 的 query 参数），前端不做二次过滤。
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { apiGet } from '../../lib/api';
import { useAsyncData, useDebounced } from '../../lib/hooks';
import type { MetaInfo, Plan, SuggestionsResponse } from '../../app/types';
import { ErrorState } from '../../components/States';
import { SuggestionsPanel } from './SuggestionsPanel';

const DEFAULT_PAGE_SIZE = 20;

export function SuggestionsPage() {
  const planSelectId = useId();
  const categorySelectId = useId();
  const keywordId = useId();
  const asOfId = useId();
  const arrivalId = useId();
  const onlyLowId = useId();

  const [planId, setPlanId] = useState('');
  const [category, setCategory] = useState('');
  const [keyword, setKeyword] = useState('');
  const debouncedKeyword = useDebounced(keyword, 360);
  const [onlyLow, setOnlyLow] = useState(false);
  const [asOf, setAsOf] = useState('');
  const [expectedArrival, setExpectedArrival] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const plansState = useAsyncData<Plan[]>(
    async (signal) => {
      const payload = await apiGet<{ plans?: Plan[] } | Plan[]>('/plans', undefined, signal);
      if (Array.isArray(payload)) return payload;
      return payload?.plans ?? [];
    },
    [],
  );

  const metaState = useAsyncData<MetaInfo>((signal) => apiGet<MetaInfo>('/meta', undefined, signal), []);

  const resetPage = () => setPage(1);

  // 任一筛选变化 → 回到第 1 页（避免空页）
  useEffect(() => {
    setPage(1);
  }, [planId, category, debouncedKeyword, onlyLow, asOf, expectedArrival, pageSize]);

  const query = useMemo(
    () => ({
      plan_id: planId || undefined,
      category: category || undefined,
      keyword: debouncedKeyword || undefined,
      as_of: asOf || undefined,
      expected_arrival: expectedArrival || undefined,
      only_low: onlyLow ? true : undefined,
      page,
      page_size: pageSize,
    }),
    [planId, category, debouncedKeyword, asOf, expectedArrival, onlyLow, page, pageSize],
  );

  const state = useAsyncData<SuggestionsResponse>(
    (signal) => apiGet<SuggestionsResponse>('/suggestions', query, signal),
    [query],
  );

  const plans = plansState.data ?? [];
  const categories = metaState.data?.categories ?? [];
  const currentPlan = plans.find((plan) => plan.plan_id === planId);

  const reset = () => {
    setPlanId('');
    setCategory('');
    setKeyword('');
    setOnlyLow(false);
    setAsOf('');
    setExpectedArrival('');
    setPage(1);
    setPageSize(DEFAULT_PAGE_SIZE);
  };

  const toolbar = (
    <div className="ra-sugg-filters">
      <label className="ra-sugg-field" htmlFor={planSelectId}>
        <span>补货方案</span>
        <select
          id={planSelectId}
          className="ra-select"
          value={planId}
          onChange={(event) => setPlanId(event.target.value)}
        >
          <option value="">默认方案</option>
          {plans.map((plan) => (
            <option key={plan.plan_id} value={plan.plan_id}>
              {plan.plan_name}
            </option>
          ))}
        </select>
      </label>

      <label className="ra-sugg-field" htmlFor={categorySelectId}>
        <span>商品分类</span>
        <select
          id={categorySelectId}
          className="ra-select"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="">所有分类</option>
          {categories.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>

      <label className="ra-sugg-field" htmlFor={keywordId}>
        <span>商品筛选</span>
        <input
          id={keywordId}
          className="ra-input"
          style={{ width: 168 }}
          placeholder="输入名称 / 编码"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
      </label>

      <label className="ra-sugg-field" htmlFor={asOfId}>
        <span>计算日</span>
        <input
          id={asOfId}
          type="date"
          className="ra-input"
          style={{ width: 140 }}
          value={asOf}
          onChange={(event) => setAsOf(event.target.value)}
        />
      </label>

      <label className="ra-sugg-field" htmlFor={arrivalId}>
        <span>预计到货</span>
        <input
          id={arrivalId}
          type="date"
          className="ra-input"
          style={{ width: 140 }}
          value={expectedArrival}
          onChange={(event) => setExpectedArrival(event.target.value)}
        />
      </label>

      <label className="ra-check" htmlFor={onlyLowId}>
        <input
          id={onlyLowId}
          type="checkbox"
          checked={onlyLow}
          onChange={(event) => setOnlyLow(event.target.checked)}
        />
        仅低库存
      </label>

      <button type="button" className="ra-btn ra-btn-primary" onClick={state.reload} disabled={state.loading}>
        {state.loading ? <span className="ra-spinner" aria-hidden="true" /> : null}
        生成建议
      </button>
      <button type="button" className="ra-btn ra-btn-link" onClick={reset}>
        重置筛选条件
      </button>
    </div>
  );

  if (state.error) {
    return (
      <div className="ra-page">
        <div className="ra-page-head">
          <div>
            <div className="ra-page-title">补货建议</div>
            <div className="ra-page-sub">非会话直查：与 #/agent 产物面板使用同一套建议表与同一后端接口。</div>
          </div>
        </div>
        <div className="ra-card">
          <ErrorState message={state.error} onRetry={state.reload} />
        </div>
      </div>
    );
  }

  return (
    <div className="ra-page">
      <div className="ra-page-head">
        <div>
          <div className="ra-page-title">
            补货建议
            {currentPlan ? <span className="ra-chip">{currentPlan.plan_name}</span> : null}
          </div>
          <div className="ra-page-sub">
            建议数量由确定性内核计算并向上取整（H1）；采购数量默认等于建议数量，人工可改，偏离显示 Δ。
          </div>
        </div>
        <div className="ra-page-actions">
          <button type="button" className="ra-btn ra-btn-sm" onClick={resetPage}>
            回到第 1 页
          </button>
          <button
            type="button"
            className="ra-btn ra-btn-sm"
            onClick={state.reload}
            disabled={state.loading}
            title="重新请求 GET /api/suggestions"
          >
            刷新
          </button>
        </div>
      </div>

      <SuggestionsPanel
        data={state.data}
        loading={state.loading}
        error={state.error}
        onRetry={state.reload}
        page={page}
        pageSize={pageSize}
        total={state.data?.total}
        totalPages={state.data?.total_pages}
        onPage={setPage}
        onPageSize={setPageSize}
        toolbar={toolbar}
      />
    </div>
  );
}
