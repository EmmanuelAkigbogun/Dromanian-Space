import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './ThroughputChart.module.css';

export interface ThroughputWeek {
  week_start: string;
  opened: number;
  completed: number;
}

interface ThroughputChartProps {
  weeks: ThroughputWeek[];
}

const HEIGHT = 240;
const PAD = { top: 16, right: 44, bottom: 28, left: 32 };

const SERIES = [
  { key: 'completed', label: 'Completed', className: 'completed' },
  { key: 'opened', label: 'Opened', className: 'opened' },
] as const;

/** Rounds the axis maximum up to a clean step so ticks read 0 / 5 / 10 … */
function niceMax(value: number): { max: number; step: number } {
  if (value <= 4) return { max: 4, step: 1 };
  const raw = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  return { max: step * 4, step };
}

const weekLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Tasks opened against tasks completed per week. Two lines on one axis; the
 * completed series carries a light wash. Hover shows a crosshair and both
 * values; the table toggle gives the same numbers without the chart.
 */
export function ThroughputChart({ weeks }: ThroughputChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [showTable]);

  const { max, step } = useMemo(() => niceMax(Math.max(1, ...weeks.flatMap((w) => [w.opened, w.completed]))), [weeks]);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (weeks.length <= 1 ? plotW / 2 : (i / (weeks.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const path = (key: 'opened' | 'completed') => weeks.map((w, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(w[key]).toFixed(1)}`).join(' ');
  const area = weeks.length
    ? `${path('completed')} L${x(weeks.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`
    : '';
  const ticks = Array.from({ length: 5 }, (_, i) => i * step);
  const last = weeks.length - 1;
  const total = weeks.reduce((sum, w) => ({ opened: sum.opened + w.opened, completed: sum.completed + w.completed }), { opened: 0, completed: 0 });

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const i = Math.round(((px - PAD.left) / plotW) * (weeks.length - 1));
    setHover(Math.min(Math.max(i, 0), last));
  }

  return (
    <div className={styles.chart}>
      <div className={styles.toolbar}>
        <div className={styles.legend} aria-hidden={showTable}>
          {SERIES.map((s) => (
            <span key={s.key} className={styles.legendItem}>
              <span className={`${styles.swatch} ${styles[s.className]}`} />
              {s.label}
              <span className={styles.legendTotal}>{total[s.key]}</span>
            </span>
          ))}
        </div>
        <button type="button" className={styles.toggle} onClick={() => setShowTable((v) => !v)} aria-pressed={showTable}>
          {showTable ? 'Chart' : 'Table'}
        </button>
      </div>

      {showTable ? (
        <table className={styles.table}>
          <caption className={styles.srOnly}>Tasks opened and completed per week</caption>
          <thead>
            <tr>
              <th scope="col">Week of</th>
              <th scope="col">Opened</th>
              <th scope="col">Completed</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.week_start}>
                <th scope="row">{weekLabel(w.week_start)}</th>
                <td>{w.opened}</td>
                <td>{w.completed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div ref={wrapRef} className={styles.plot}>
          <svg width="100%" height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={`Tasks per week: ${total.opened} opened and ${total.completed} completed over ${weeks.length} weeks`}>
            {ticks.map((t) => (
              <g key={t}>
                <line className={styles.grid} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
                <text className={styles.axis} x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">{t}</text>
              </g>
            ))}
            {weeks.map((w, i) => (
              <text key={w.week_start} className={styles.axis} x={x(i)} y={HEIGHT - 8} textAnchor="middle">
                {i % (width < 480 ? 2 : 1) === 0 || i === last ? weekLabel(w.week_start) : ''}
              </text>
            ))}
            <path className={styles.wash} d={area} />
            <path className={`${styles.line} ${styles.opened}`} d={path('opened')} />
            <path className={`${styles.line} ${styles.completed}`} d={path('completed')} />
            {last >= 0 && SERIES.map((s) => (
              <g key={s.key}>
                <circle className={`${styles.dot} ${styles[s.className]}`} cx={x(last)} cy={y(weeks[last][s.key])} r={4} />
                <text
                  className={styles.endLabel}
                  x={x(last) + 9}
                  y={y(weeks[last][s.key])}
                  dy={weeks[last].opened === weeks[last].completed ? (s.key === 'opened' ? '1.1em' : '-0.3em') : '0.32em'}
                >
                  {weeks[last][s.key]}
                </text>
              </g>
            ))}
            {hover !== null && (
              <g>
                <line className={styles.crosshair} x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} />
                {SERIES.map((s) => (
                  <circle key={s.key} className={`${styles.dot} ${styles[s.className]}`} cx={x(hover)} cy={y(weeks[hover][s.key])} r={5} />
                ))}
              </g>
            )}
            <rect
              className={styles.hit}
              x={PAD.left - 12}
              y={PAD.top}
              width={plotW + 24}
              height={plotH}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
          {hover !== null && (
            <div
              className={styles.tooltip}
              style={{ left: `${(x(hover) / width) * 100}%`, transform: `translateX(${hover > last / 2 ? 'calc(-100% - 12px)' : '12px'})` }}
              role="status"
            >
              <div className={styles.tooltipTitle}>Week of {weekLabel(weeks[hover].week_start)}</div>
              {SERIES.map((s) => (
                <div key={s.key} className={styles.tooltipRow}>
                  <span className={`${styles.swatch} ${styles[s.className]}`} />
                  <span className={styles.tooltipLabel}>{s.label}</span>
                  <span className={styles.tooltipValue}>{weeks[hover][s.key]}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
