/**
 * Citation.tsx — 公式横幅 / 来源条（Citation strip）
 *
 * 三态（v1 `.formula` / `.formula.documented` 的迁移）：
 *   documented  绿色  — 方案 1/2/3、闸门、15 天窗口等有官方依据
 *   enhancement 紫色  — σ 方案 / 预测 / 装箱 MOQ 等本实现增强
 *   assumption  红色  — 依赖未证实假设；假设 chip 可点进 #/assumptions
 *
 * 允许「绿色公式 + 红色假设 chip」并存：官方公式本身 depends on 未证实假设（如 H1 ceil）。
 */
import type { ReactNode } from 'react';
import { navigate } from '../app/router';
import type { Provenance } from '../app/types';
import { fmtDate } from '../lib/format';
import { PROVENANCE_HINT, PROVENANCE_LABEL, ProvenanceTag } from './ProvenanceTag';

export type CitationState = 'documented' | 'enhancement' | 'assumption';

export const PLAN_TYPE_LABEL: Record<string, string> = {
  avg_daily: '按日均销量补货',
  stock_upper: '按库存上限补货',
  custom: '自定义方案',
};

export function citationState(provenance?: Provenance, assumptions: string[] = []): CitationState {
  if (provenance === 'assumption') return 'assumption';
  if (provenance === 'documented') return 'documented';
  if (provenance === 'enhancement') return 'enhancement';
  return assumptions.length > 0 ? 'assumption' : 'enhancement';
}

const STATE_TEXT: Record<CitationState, string> = {
  documented: '官方文档依据',
  enhancement: '本实现增强 · 非官方口径',
  assumption: '依赖未证实假设',
};

const STATE_HINT: Record<CitationState, string> = {
  documented: PROVENANCE_HINT.documented,
  enhancement: PROVENANCE_HINT.enhancement,
  assumption: PROVENANCE_HINT.assumption,
};

export interface CitationStripProps {
  provenance?: Provenance;
  /** 服务端返回的 formula_text（官方原文逐字） */
  formulaText?: string;
  planName?: string;
  planType?: string;
  assumptions?: string[];
  guardNote?: string;
  asOf?: string;
  expectedArrival?: string;
  /** 右侧附加操作（导出 / 刷新等） */
  actions?: ReactNode;
  compact?: boolean;
}

export function CitationStrip({
  provenance,
  formulaText,
  planName,
  planType,
  assumptions = [],
  guardNote,
  asOf,
  expectedArrival,
  actions,
  compact = false,
}: CitationStripProps) {
  const state = citationState(provenance, assumptions);
  const planLabel = planType ? PLAN_TYPE_LABEL[planType] ?? planType : undefined;

  return (
    <div className="ra-citation">
      <div className="ra-citation-main">
        <div className="ra-citation-label">
          <span className="ra-section-title" style={{ paddingLeft: 0 }}>
            {planName ? `方案：${planName}` : '计算公式'}
          </span>
          {planLabel ? <span className="ra-chip">{planLabel}</span> : null}
          <ProvenanceTag provenance={provenance} assumptions={assumptions} />
          {asOf ? <span className="ra-faint">as_of {fmtDate(asOf)}</span> : null}
          {expectedArrival ? <span className="ra-faint">预计到货 {fmtDate(expectedArrival)}</span> : null}
        </div>

        <div className={`ra-formula ra-formula-${state}`} data-tip={STATE_HINT[state]}>
          {formulaText && formulaText.trim() !== ''
            ? formulaText
            : '（服务端未返回 formula_text；公式文案应来自 domain.formulaText，前端不自行拼接）'}
        </div>

        {assumptions.length > 0 ? (
          <div className="ra-citation-assumptions">
            <span className="ra-faint ra-xs">依赖未证实假设：</span>
            {assumptions.map((id) => (
              <button
                key={id}
                type="button"
                className="ra-chip ra-chip-click"
                style={{ color: 'var(--ra-danger)', borderColor: 'var(--ra-danger-border)', background: 'var(--ra-danger-light)' }}
                onClick={() => navigate('/assumptions')}
                data-tip={`${id}：点击打开假设登记表，查看该假设的置信度与验证方式`}
              >
                ⚠ {id}
              </button>
            ))}
            <span className="ra-faint ra-xs">（结论可能随假设翻盘而改变）</span>
          </div>
        ) : null}

        {guardNote && !compact ? <div className="ra-hint">{guardNote}</div> : null}
      </div>

      <div className="ra-citation-side">
        <span className="ra-citation-label">出处与口径</span>
        <span style={{ fontSize: 12 }}>{STATE_TEXT[state]}</span>
        <button
          type="button"
          className="ra-btn ra-btn-sm"
          onClick={() => navigate('/assumptions')}
          data-tip="假设登记表 H1–H8：假设 / 置信度 / 影响 / 验证方式"
        >
          假设登记
        </button>
        {actions ? <div className="ra-row ra-gap-2 ra-wrap">{actions}</div> : null}
      </div>
    </div>
  );
}

/** 数字旁的小徽标：别名到 ProvenanceTag，保证「每个数字可自证」的调用一致 */
export { ProvenanceTag, PROVENANCE_LABEL };
