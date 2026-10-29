/**
 * FormRow.tsx — 表单行（label 必带 htmlFor，可访问性硬性要求）
 *
 * 用法：<FormRow label="模板名称" htmlFor={nameId} required hint="20 字以内">
 *         <input id={nameId} ... />
 *       </FormRow>
 * 没有天然可关联控件时（单选组 / 复选组），用 <fieldset>/<legend> 而不是伪造 label。
 */
import type { ReactNode } from 'react';

export interface FormRowProps {
  label: ReactNode;
  /** 必须指向同一行控件的 id（任务纪律：label 全部 htmlFor） */
  htmlFor: string;
  children: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  /** 标签宽度覆盖 */
  labelWidth?: number;
}

export function FormRow({ label, htmlFor, children, required, hint, error, labelWidth }: FormRowProps) {
  return (
    <div className="ra-form-row">
      <label htmlFor={htmlFor} style={labelWidth ? { flexBasis: labelWidth } : undefined}>
        {required ? (
          <span className="ra-req" aria-hidden="true">
            *
          </span>
        ) : null}
        {label}
      </label>
      <div className="ra-form-control">
        {children}
        {hint ? <div className="ra-hint">{hint}</div> : null}
        {error ? (
          <div className="ra-error-text" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 复选框组 / 单选组用 fieldset + legend，保证有可访问名 */
export function FormGroup({
  legend,
  children,
  hint,
  required,
}: {
  legend: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  required?: boolean;
}) {
  return (
    <fieldset className="ra-form-row ra-fieldset">
      <legend className="ra-form-label">
        {required ? (
          <span className="ra-req" aria-hidden="true">
            *
          </span>
        ) : null}
        {legend}
      </legend>
      <div className="ra-form-control">
        {children}
        {hint ? <div className="ra-hint">{hint}</div> : null}
      </div>
    </fieldset>
  );
}
