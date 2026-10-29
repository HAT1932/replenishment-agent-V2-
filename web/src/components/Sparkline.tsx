/**
 * Sparkline.tsx — 零依赖 SVG 迷你折线（日销量 + 7 日均线 + 柱形底纹）
 *
 * 修 v1 的缺陷：v1 把渐变 id 硬编码成 "sparkFill"，同页多个图会互相覆盖；
 * 这里用 React 18 的 useId() 生成唯一 id（并把 ':' 去掉，避免 SVG url(#a:b) 解析问题）。
 * 纯展示：不计算业务值，只按传入 qty 画坐标。
 */
import { useId, useState } from 'react';

export interface SparkPoint {
  date: string;
  qty: number;
}

export interface SparklineProps {
  data: SparkPoint[];
  height?: number;
  showBars?: boolean;
  showAverage?: boolean;
  /** 图例/读数区标题，同时作为无障碍描述 */
  label?: string;
  /** 空数据文案 */
  emptyText?: string;
}

const VIEW_W = 500;
const PAD = { l: 28, r: 8, t: 8, b: 16 };

export function Sparkline({
  data,
  height = 76,
  showBars = true,
  showAverage = true,
  label = '日销量',
  emptyText = '暂无销量数据',
}: SparklineProps) {
  const [hover, setHover] = useState<number | null>(null);
  const rawId = useId();
  const gradientId = `ra-spark-${rawId.replace(/[:#]/g, '')}`;

  if (data.length === 0) {
    return (
      <div className="ra-empty" style={{ padding: '18px 0' }}>
        {emptyText}
      </div>
    );
  }

  const H = height;
  const iw = VIEW_W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const max = Math.max(1, ...data.map((point) => (Number.isFinite(point.qty) ? point.qty : 0)));

  const points = data.map((point, index) => {
    const qty = Number.isFinite(point.qty) ? point.qty : 0;
    const x = PAD.l + (data.length <= 1 ? iw / 2 : (index / (data.length - 1)) * iw);
    const y = PAD.t + ih - (qty / max) * ih;
    return { x, y, qty, date: point.date, index };
  });

  // 7 日移动均线（仅展示，本身不是业务指标）
  const ma = points.map((point) => {
    const from = Math.max(0, point.index - 6);
    const slice = data.slice(from, point.index + 1);
    const avg = slice.reduce((sum, item) => sum + (Number.isFinite(item.qty) ? item.qty : 0), 0) / slice.length;
    return { x: point.x, y: PAD.t + ih - (avg / max) * ih };
  });

  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ');
  const lastX = points[points.length - 1]?.x ?? PAD.l;
  const areaPath = `${linePath} L${lastX},${PAD.t + ih} L${PAD.l},${PAD.t + ih} Z`;
  const maPath = ma.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');

  const active = hover !== null ? points[hover] : null;
  const slot = iw / Math.max(1, data.length);

  return (
    <div className="ra-spark-wrap">
      <svg
        viewBox={`0 0 ${VIEW_W} ${H}`}
        style={{ width: '100%', height: H, display: 'block' }}
        role="img"
        aria-label={`${label}走势：${data.length} 个数据点，峰值 ${Math.round(max)}`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ra-chart-1)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--ra-chart-1)" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {[0, 0.5, 1].map((fraction) => {
          const y = PAD.t + ih - fraction * ih;
          return (
            <g key={fraction}>
              <line x1={PAD.l} y1={y} x2={VIEW_W - PAD.r} y2={y} stroke="var(--ra-chart-grid)" strokeWidth="1" />
              <text x={PAD.l - 4} y={y + 3} textAnchor="end" fontSize="8" fill="var(--ra-chart-axis)">
                {Math.round(max * fraction)}
              </text>
            </g>
          );
        })}

        {showBars
          ? points.map((point) => {
              const barWidth = Math.max(1, slot - 1.2);
              const barHeight = ih - (point.y - PAD.t);
              return (
                <rect
                  key={`bar-${point.date}`}
                  x={point.x - barWidth / 2}
                  y={point.y}
                  width={barWidth}
                  height={Math.max(0, barHeight)}
                  fill="var(--ra-chart-bar)"
                  rx={1}
                />
              );
            })
          : null}

        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path d={linePath} fill="none" stroke="var(--ra-chart-1)" strokeWidth="1.4" strokeLinejoin="round" />
        {showAverage ? (
          <path
            d={maPath}
            fill="none"
            stroke="var(--ra-chart-2)"
            strokeWidth="1.2"
            strokeDasharray="3 2"
          />
        ) : null}

        {/* 悬停热区（每个数据点一列） */}
        {points.map((point) => (
          <rect
            key={`hit-${point.date}`}
            x={point.x - slot / 2}
            y={PAD.t}
            width={Math.max(2, slot)}
            height={ih}
            fill="transparent"
            onMouseEnter={() => setHover(point.index)}
          />
        ))}

        {active ? (
          <g pointerEvents="none">
            <line
              x1={active.x}
              y1={PAD.t}
              x2={active.x}
              y2={PAD.t + ih}
              stroke="var(--ra-chart-1)"
              strokeDasharray="2 2"
            />
            <circle cx={active.x} cy={active.y} r="2.6" fill="var(--ra-chart-1)" />
          </g>
        ) : null}

        <text x={PAD.l} y={H - 4} fontSize="8" fill="var(--ra-chart-axis)">
          {data[0]?.date?.slice(5) ?? ''}
        </text>
        <text x={VIEW_W - PAD.r} y={H - 4} fontSize="8" fill="var(--ra-chart-axis)" textAnchor="end">
          {data[data.length - 1]?.date?.slice(5) ?? ''}
        </text>
      </svg>

      <div className="ra-row ra-xs ra-faint" style={{ justifyContent: 'space-between', padding: '2px 2px 4px' }}>
        <span className="ra-row ra-gap-3">
          <span>
            <span style={{ color: 'var(--ra-chart-1)' }}>━</span> {label}
          </span>
          {showAverage ? (
            <span>
              <span style={{ color: 'var(--ra-chart-2)' }}>┄</span> 7 日均线
            </span>
          ) : null}
        </span>
        <span className="ra-num">
          {active ? `${active.date} · ${active.qty}` : `峰值 ${Math.round(max)} · ${data.length} 天`}
        </span>
      </div>
    </div>
  );
}
