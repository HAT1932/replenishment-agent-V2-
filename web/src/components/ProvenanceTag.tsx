/**
 * ProvenanceTag.tsx — 溯源小徽标（可 hover 看依据 / 假设可点开登记表）
 *
 * 三态严格对应契约 §2.6：
 *   documented  → 有 official 文档/截图证据
 *   enhancement → 本实现增强（与文档口径严格分离）
 *   assumption  → 依赖未证实假设（红色，可点开 #/assumptions）
 */
import { navigate } from '../app/router';
import type { Provenance } from '../app/types';

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  documented: '官方依据',
  enhancement: '实现增强',
  assumption: '未证实假设',
};

export const PROVENANCE_HINT: Record<Provenance, string> = {
  documented: '该数值有官方文档/截图依据（契约 §2.6 provenance=documented）。',
  enhancement: '本实现增强，非官方口径；与 documented 严格分离（契约 §2.6）。',
  assumption: '依赖未证实假设，结论可能随假设翻盘而改变（契约 §2.6）。',
};

export interface ProvenanceTagProps {
  provenance?: Provenance;
  /** 依赖的假设 id（如 ['H1','H3']），assumption 态必填 */
  assumptions?: string[];
  /** 覆盖默认 tooltip */
  hint?: string;
  /** 是否显示假设 id（默认 true） */
  showAssumptions?: boolean;
}

export function ProvenanceTag({
  provenance,
  assumptions = [],
  hint,
  showAssumptions = true,
}: ProvenanceTagProps) {
  const state: Provenance = provenance ?? (assumptions.length > 0 ? 'assumption' : 'enhancement');
  const ids = showAssumptions ? assumptions.filter(Boolean) : [];
  const tip = hint ?? PROVENANCE_HINT[state];
  const text = ids.length > 0 ? `${PROVENANCE_LABEL[state]} ${ids.join('/')}` : PROVENANCE_LABEL[state];

  if (state === 'assumption') {
    const tipWithIds =
      ids.length > 0
        ? `${tip}\n涉及假设：${ids.join('、')}。点击打开假设登记表（#/assumptions）。`
        : `${tip}\n点击打开假设登记表（#/assumptions）。`;
    return (
      <button
        type="button"
        className="ra-prov ra-prov-assumption"
        data-tip={tipWithIds}
        onClick={() => navigate('/assumptions')}
        aria-label={`${text}，点击查看假设登记表`}
      >
        ⚠ {text}
      </button>
    );
  }

  return (
    <span
      className={`ra-prov ra-prov-${state}`}
      data-tip={tip}
      tabIndex={0}
      aria-label={`${PROVENANCE_LABEL[state]}：${tip}`}
    >
      {state === 'documented' ? '✓' : '◈'} {text}
    </span>
  );
}
