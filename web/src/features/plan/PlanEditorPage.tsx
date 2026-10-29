/**
 * PlanEditorPage.tsx — 新建 / 编辑补货方案（#/plans/new、#/plans/:id）
 *
 * 保留 v1 做得好的两点：三段式 FormRow（htmlFor 齐全）+ 实时公式联动；
 * 修 v1 的三个坑：plan_type 编辑态不可变要**提前说明**、不要原地 mutate 父级 props、
 * 编辑与新建使用不同的路由 key（#/plans/new 与 #/plans/:id）。
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { apiGet, apiPost, apiPut, errorMessage } from '../../lib/api';
import { useAsyncData } from '../../lib/hooks';
import { navigate } from '../../app/router';
import type { Plan, PlanConfig, PlanType } from '../../app/types';
import { PLAN_TYPE_LABEL } from '../../components/Citation';
import { CitationStrip } from '../../components/Citation';
import { FormGroup, FormRow } from '../../components/FormRow';
import { ErrorState, InlineAlert, LoadingBlock } from '../../components/States';
import { useToast } from '../../components/Toast';

/** 官方公式逐字文本（report §4.1，documented 口径） */
const OFFICIAL_FORMULA: Record<PlanType, string> = {
  avg_daily: '建议数量 = 近15天日均销量 × 可售天数 + 库存预警下限 − 可售库存',
  stock_upper: '建议数量 = 库存上限 − 当前实物库存',
  custom: '建议数量 = (近15天日均销量 × 采购周期 + 库存预警下限 − 可售库存 − 在途库存) × 综合系数',
};

interface FormState {
  plan_name: string;
  remark: string;
  plan_type: PlanType;
  purchase_cycle_days: string;
  coverage_days: string;
  coefficient_enabled: boolean;
  weekend_enabled: boolean;
  weekend_value: string;
  holiday_enabled: boolean;
  holiday_value: string;
}

const EMPTY_FORM: FormState = {
  plan_name: '',
  remark: '',
  plan_type: 'avg_daily',
  purchase_cycle_days: '',
  coverage_days: '',
  coefficient_enabled: false,
  weekend_enabled: false,
  weekend_value: '',
  holiday_enabled: false,
  holiday_value: '',
};

function toForm(plan: Plan): FormState {
  const config: PlanConfig = plan.config ?? {};
  return {
    plan_name: plan.plan_name ?? '',
    remark: plan.remark ?? '',
    plan_type: (plan.plan_type as PlanType) ?? 'avg_daily',
    purchase_cycle_days:
      config.purchase_cycle_days === undefined ? '' : String(config.purchase_cycle_days),
    coverage_days: config.coverage_days === undefined ? '' : String(config.coverage_days),
    coefficient_enabled: config.coefficient_enabled === true,
    weekend_enabled: config.weekend_coefficient_enabled === true,
    weekend_value: config.weekend_coefficient === undefined ? '' : String(config.weekend_coefficient),
    holiday_enabled: config.holiday_coefficient_enabled === true,
    holiday_value: config.holiday_coefficient === undefined ? '' : String(config.holiday_coefficient),
  };
}

/** 把已填参数代入公式文本（纯文本联动，不做任何计算） */
function liveFormula(form: FormState): string {
  if (form.plan_type === 'stock_upper') return OFFICIAL_FORMULA.stock_upper;
  if (form.plan_type === 'avg_daily') {
    const days = form.coverage_days.trim() === '' ? '可售天数' : `${form.coverage_days} 天`;
    return `建议数量 = 近15天日均销量 × ${days} + 库存预警下限 − 可售库存`;
  }
  const cycle = form.purchase_cycle_days.trim() === '' ? '采购周期' : `${form.purchase_cycle_days} 天`;
  return `建议数量 = (近15天日均销量 × ${cycle} + 库存预警下限 − 可售库存 − 在途库存) × 综合系数`;
}

export function PlanEditorPage({ planId }: { planId: string | null }) {
  const toast = useToast();
  const editing = planId !== null;

  const nameId = useId();
  const remarkId = useId();
  const typeId = useId();
  const cycleId = useId();
  const coverageId = useId();
  const weekendId = useId();
  const weekendValueId = useId();
  const holidayId = useId();
  const holidayValueId = useId();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!editing);

  const planState = useAsyncData<Plan>(
    async (signal) => {
      const payload = await apiGet<Plan | { plan?: Plan }>(
        `/plans/${encodeURIComponent(planId ?? '')}`,
        undefined,
        signal,
      );
      // platform 可能返回 data=plan 或 data={plan}
      return payload && typeof payload === 'object' && 'plan' in payload
        ? ((payload as { plan?: Plan }).plan ?? (payload as unknown as Plan))
        : (payload as Plan);
    },
    [planId],
    { enabled: editing },
  );

  useEffect(() => {
    if (planState.data) {
      setForm(toForm(planState.data));
      setLoaded(true);
    }
  }, [planState.data]);

  const patch = (partial: Partial<FormState>) => setForm((prev) => ({ ...prev, ...partial }));

  const save = async () => {
    setFieldError(null);
    setSaveError(null);

    if (form.plan_name.trim() === '') {
      setFieldError('方案名称必填');
      return;
    }

    const parsePositive = (raw: string, label: string): number | undefined | null => {
      if (raw.trim() === '') return undefined;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        setFieldError(`${label} 必须是正数`);
        return null;
      }
      return value;
    };

    const purchaseCycle = parsePositive(form.purchase_cycle_days, '采购周期');
    if (purchaseCycle === null) return;
    const coverage = parsePositive(form.coverage_days, '可售天数');
    if (coverage === null) return;
    const weekendValue = parsePositive(form.weekend_value, '双休日系数');
    if (weekendValue === null) return;
    const holidayValue = parsePositive(form.holiday_value, '重大节假日系数');
    if (holidayValue === null) return;

    const config: PlanConfig = {
      purchase_cycle_days: purchaseCycle,
      coverage_days: coverage,
      coefficient_enabled: form.coefficient_enabled,
      weekend_coefficient_enabled: form.weekend_enabled,
      weekend_coefficient: weekendValue,
      holiday_coefficient_enabled: form.holiday_enabled,
      holiday_coefficient: holidayValue,
    };

    const body = {
      plan_name: form.plan_name.trim(),
      plan_type: form.plan_type,
      remark: form.remark.trim() === '' ? undefined : form.remark.trim(),
      config,
    };

    setSaving(true);
    try {
      if (editing && planId) {
        await apiPut<Plan>(`/plans/${encodeURIComponent(planId)}`, body);
        toast('方案已保存', 'ok');
      } else {
        await apiPost<Plan>('/plans', body);
        toast('方案已创建', 'ok');
      }
      navigate('/plans');
    } catch (e: unknown) {
      const message = errorMessage(e);
      setSaveError(message);
      toast(`保存失败：${message}`, 'err');
    } finally {
      setSaving(false);
    }
  };

  const provenance = planState.data?.provenance;
  const formulaText = useMemo(
    () => (planState.data?.formula_text ? planState.data.formula_text : liveFormula(form)),
    [planState.data?.formula_text, form],
  );

  if (editing && planState.error) {
    return (
      <div className="ra-page">
        <ErrorState message={planState.error} onRetry={planState.reload} />
      </div>
    );
  }

  if (!loaded && planState.loading) {
    return (
      <div className="ra-page">
        <LoadingBlock text="正在加载方案…" />
      </div>
    );
  }

  return (
    <div className="ra-page">
      <div className="ra-row ra-gap-2 ra-sm ra-dim ra-mb-3">
        <button type="button" className="ra-link" onClick={() => navigate('/plans')}>
          补货方案
        </button>
        <span aria-hidden="true">/</span>
        <span>{editing ? '编辑方案' : '新建方案'}</span>
      </div>

      <div className="ra-page-head">
        <div>
          <div className="ra-page-title">{editing ? '编辑补货方案' : '新建补货方案'}</div>
          <div className="ra-page-sub">
            方案 1/2/3 的公式与口径来自官方文档（documented）；综合系数窗口口径为未证实假设 H3。
          </div>
        </div>
      </div>

      <div className="ra-card ra-plan-form">
        <div className="ra-card-head">
          <div className="ra-card-title">基本信息</div>
        </div>
        <div className="ra-plan-section">
          <FormRow label="方案名称" htmlFor={nameId} required hint="最长 20 个字符，与官方模板命名一致">
            <input
              id={nameId}
              className="ra-input"
              value={form.plan_name}
              maxLength={20}
              onChange={(event) => patch({ plan_name: event.target.value })}
              aria-invalid={form.plan_name.trim() === ''}
            />
          </FormRow>

          <FormRow
            label="方案类型"
            htmlFor={typeId}
            required
            hint={
              editing
                ? '方案类型创建后不可更改（会影响已生成建议的口径解释），如需变更请新建方案。'
                : '三种官方方案；类型决定使用哪条公式。'
            }
          >
            <select
              id={typeId}
              className="ra-select"
              value={form.plan_type}
              disabled={editing}
              onChange={(event) => patch({ plan_type: event.target.value as PlanType })}
            >
              {(Object.keys(PLAN_TYPE_LABEL) as PlanType[]).map((type) => (
                <option key={type} value={type}>
                  {PLAN_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </FormRow>

          <FormRow label="备注" htmlFor={remarkId} hint="可选，会显示在方案列表与审计里">
            <input
              id={remarkId}
              className="ra-input"
              value={form.remark}
              maxLength={200}
              onChange={(event) => patch({ remark: event.target.value })}
            />
          </FormRow>
        </div>

        <div className="ra-card-head">
          <div className="ra-card-title">补货方案</div>
        </div>
        <div className="ra-plan-section">
          <div className="ra-hint ra-mb-3">计算公式（随参数实时联动；最终以服务端 formula_text 为准）</div>
          <div className="ra-plan-formula">
            <CitationStrip
              compact
              provenance={provenance ?? 'documented'}
              formulaText={formulaText}
              planName={form.plan_name || undefined}
              planType={form.plan_type}
              assumptions={['H1', 'H2', 'H3']}
            />
          </div>

          <FormRow
            label="采购周期"
            htmlFor={cycleId}
            hint="第一次补货与第二次补货之间的时间间隔（天）。方案 3 参与计算。"
          >
            <div className="ra-row ra-gap-2">
              <input
                id={cycleId}
                className="ra-input ra-input-num"
                style={{ width: 96 }}
                inputMode="numeric"
                placeholder="如 7"
                value={form.purchase_cycle_days}
                onChange={(event) => patch({ purchase_cycle_days: event.target.value.replace(/[^\d.]/g, '') })}
              />
              <span className="ra-muted ra-sm">天</span>
            </div>
          </FormRow>

          <FormRow
            label="可售天数"
            htmlFor={coverageId}
            hint="方案 1 的覆盖天数（官方示例中为 7 天，曾出现 31 天的文案差异）。"
          >
            <div className="ra-row ra-gap-2">
              <input
                id={coverageId}
                className="ra-input ra-input-num"
                style={{ width: 96 }}
                inputMode="numeric"
                placeholder="如 7"
                value={form.coverage_days}
                onChange={(event) => patch({ coverage_days: event.target.value.replace(/[^\d.]/g, '') })}
              />
              <span className="ra-muted ra-sm">天</span>
            </div>
          </FormRow>

          <FormGroup
            legend="综合系数"
            hint="系数用于调整「预计到货日 → 下一次补货发起日」这段时间的销量波动；同一天命中多个系数时取较大者。"
          >
            <div className="ra-coef-config">
              <label className="ra-check" htmlFor={weekendId}>
                <input
                  id={weekendId}
                  type="checkbox"
                  checked={form.weekend_enabled}
                  onChange={(event) => patch({ weekend_enabled: event.target.checked })}
                />
                双休日系数
              </label>
              <div className="ra-coef-config-row">
                <label className="ra-sr-only" htmlFor={weekendValueId}>
                  双休日系数数值
                </label>
                <input
                  id={weekendValueId}
                  className="ra-input ra-input-num"
                  placeholder="如 1.1"
                  inputMode="decimal"
                  disabled={!form.weekend_enabled}
                  value={form.weekend_value}
                  onChange={(event) => patch({ weekend_value: event.target.value.replace(/[^\d.]/g, '') })}
                />
                <span className="ra-hint">
                  如果双休日的销量是平日销量的 1.1 倍，该系数可以填写为 1.1。
                </span>
              </div>

              <label className="ra-check" htmlFor={holidayId}>
                <input
                  id={holidayId}
                  type="checkbox"
                  checked={form.holiday_enabled}
                  onChange={(event) => patch({ holiday_enabled: event.target.checked })}
                />
                重大节假日系数
              </label>
              <div className="ra-coef-config-row">
                <label className="ra-sr-only" htmlFor={holidayValueId}>
                  重大节假日系数数值
                </label>
                <input
                  id={holidayValueId}
                  className="ra-input ra-input-num"
                  placeholder="如 1.2"
                  inputMode="decimal"
                  disabled={!form.holiday_enabled}
                  value={form.holiday_value}
                  onChange={(event) => patch({ holiday_value: event.target.value.replace(/[^\d.]/g, '') })}
                />
                <span className="ra-hint">
                  如果重大节假日的销量是平日销量的 1.1 倍，该系数可以填写为 1.1。
                </span>
              </div>

              <label className="ra-check" htmlFor={`${weekendId}-enabled`}>
                <input
                  id={`${weekendId}-enabled`}
                  type="checkbox"
                  checked={form.coefficient_enabled}
                  onChange={(event) => patch({ coefficient_enabled: event.target.checked })}
                />
                启用综合系数（方案 3 参与计算；方案 1/2 公式不含系数）
              </label>
            </div>
          </FormGroup>
        </div>

        {fieldError ? (
          <div style={{ padding: '0 20px 12px' }}>
            <InlineAlert tone="danger">{fieldError}</InlineAlert>
          </div>
        ) : null}
        {saveError ? (
          <div style={{ padding: '0 20px 12px' }}>
            <InlineAlert tone="danger">{saveError}</InlineAlert>
          </div>
        ) : null}

        <div className="ra-form-actions">
          <button type="button" className="ra-btn ra-btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? <span className="ra-spinner" aria-hidden="true" /> : null}
            保存
          </button>
          <button type="button" className="ra-btn" onClick={() => navigate('/plans')} disabled={saving}>
            取消
          </button>
          <span className="ra-hint">保存后返回方案列表；系统默认方案禁删但仍可编辑。</span>
        </div>
      </div>
    </div>
  );
}
