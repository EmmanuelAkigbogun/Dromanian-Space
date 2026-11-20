// Visual blocks agents can write inside their answers:
//   ```chart  {"type":"bar"|"pie","title":"…","unit":"…","data":[{"label":"…","value":12}]}
//   ```stats  [{"label":"…","value":"57","note":"of 200","tone":"good|warn|bad"}]
// Anything malformed falls back to showing the block as code.
import styles from './Markdown.module.css';

interface Point { label: string; value: number }
interface ChartSpec { type?: 'bar' | 'pie' | 'donut'; title?: string; unit?: string; data: Point[] }
interface Stat { label: string; value: string | number; note?: string; tone?: 'good' | 'warn' | 'bad' | 'neutral' }

const PALETTE = ['#8b7cf6', '#38bdf8', '#34d399', '#f59e0b', '#fb7185', '#a3e635', '#e879f9', '#2dd4bf', '#fb923c', '#94a3b8'];

export function parseChart(body: string): ChartSpec | null {
  try {
    const spec = JSON.parse(body) as ChartSpec;
    const data = (spec.data ?? []).filter((d) => d && typeof d.label === 'string' && Number.isFinite(Number(d.value))).map((d) => ({ label: d.label, value: Number(d.value) }));
    return data.length ? { ...spec, data: data.slice(0, 24) } : null;
  } catch { return null; }
}

export function parseStats(body: string): Stat[] | null {
  try {
    const raw = JSON.parse(body) as Stat[] | { items?: Stat[] };
    const items = Array.isArray(raw) ? raw : raw.items ?? [];
    const ok = items.filter((s) => s && typeof s.label === 'string' && s.value !== undefined).slice(0, 8);
    return ok.length ? ok : null;
  } catch { return null; }
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function Chart({ spec }: { spec: ChartSpec }) {
  const total = spec.data.reduce((s, d) => s + Math.max(0, d.value), 0);
  const unit = spec.unit ? ` ${spec.unit}` : '';
  if ((spec.type === 'pie' || spec.type === 'donut') && total > 0) {
    let angle = -Math.PI / 2;
    const arcs = spec.data.map((d, i) => {
      const share = Math.max(0, d.value) / total;
      const start = angle;
      angle += share * Math.PI * 2;
      const large = share > 0.5 ? 1 : 0;
      const p = (a: number, r: number) => `${50 + r * Math.cos(a)} ${50 + r * Math.sin(a)}`;
      const path = share >= 0.9999
        ? `M 50 8 A 42 42 0 1 1 49.99 8 L 49.99 26 A 24 24 0 1 0 50 26 Z`
        : `M ${p(start, 42)} A 42 42 0 ${large} 1 ${p(angle, 42)} L ${p(angle, 24)} A 24 24 0 ${large} 0 ${p(start, 24)} Z`;
      return { d, i, path, share };
    });
    return (
      <figure className={styles.chart}>
        {spec.title && <figcaption>{spec.title}</figcaption>}
        <div className={styles.donutWrap}>
          <svg viewBox="0 0 100 100" className={styles.donut} role="img" aria-label={spec.title ?? 'Chart'}>
            {arcs.map((a) => <path key={a.i} d={a.path} fill={PALETTE[a.i % PALETTE.length]}><title>{`${a.d.label}: ${fmt(a.d.value)}${unit}`}</title></path>)}
            <text x="50" y="49" textAnchor="middle" className={styles.donutTotal}>{fmt(total)}</text>
            <text x="50" y="60" textAnchor="middle" className={styles.donutUnit}>{spec.unit ?? 'total'}</text>
          </svg>
          <ul className={styles.legend}>
            {arcs.map((a) => (
              <li key={a.i}><span style={{ background: PALETTE[a.i % PALETTE.length] }} />{a.d.label}<strong>{fmt(a.d.value)}{unit}</strong><em>{Math.round(a.share * 100)}%</em></li>
            ))}
          </ul>
        </div>
      </figure>
    );
  }
  const max = Math.max(...spec.data.map((d) => d.value), 0) || 1;
  return (
    <figure className={styles.chart}>
      {spec.title && <figcaption>{spec.title}</figcaption>}
      <div className={styles.bars} role="img" aria-label={spec.title ?? 'Chart'}>
        {spec.data.map((d, i) => (
          <div key={i} className={styles.barRow}>
            <span className={styles.barLabel} title={d.label}>{d.label}</span>
            <span className={styles.barTrack}><span style={{ width: `${Math.max(2, (Math.max(0, d.value) / max) * 100)}%`, background: PALETTE[i % PALETTE.length], animationDelay: `${i * 40}ms` }} /></span>
            <strong>{fmt(d.value)}{unit}</strong>
          </div>
        ))}
      </div>
    </figure>
  );
}

export function Stats({ items }: { items: Stat[] }) {
  return (
    <div className={styles.stats}>
      {items.map((s, i) => (
        <div key={i} className={styles.stat} data-tone={s.tone ?? 'neutral'}>
          <span>{s.label}</span>
          <strong>{typeof s.value === 'number' ? fmt(s.value) : s.value}</strong>
          {s.note && <em>{s.note}</em>}
        </div>
      ))}
    </div>
  );
}

const STATUS: Record<string, 'good' | 'warn' | 'bad' | 'info'> = {
  done: 'good', completed: 'good', complete: 'good', approved: 'good', active: 'good', yes: 'good', ok: 'good', live: 'good', connected: 'good',
  'in progress': 'info', 'in_progress': 'info', 'in review': 'info', pending: 'warn', 'waiting': 'warn', 'at risk': 'warn', 'not started': 'warn', todo: 'warn', 'to do': 'warn', partial: 'warn',
  blocked: 'bad', failed: 'bad', overdue: 'bad', no: 'bad', missing: 'bad', rejected: 'bad', 'not connected': 'bad',
};

/** A table cell that is just a status word becomes a coloured pill. */
export function statusTone(text: string): 'good' | 'warn' | 'bad' | 'info' | null {
  return STATUS[text.trim().replace(/^(?:✅|⚠️|❌|🟢|🟡|🔴)\s*/u, '').toLowerCase()] ?? null;
}
