// The insights strip above each CRM list: bento tiles that sum up the
// records in the current view. Bars and list rows are clickable and filter
// the list below.
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { formatMoney, humanize, type Company, type Context, type Contact, type CrmRecord, type Deal, type Kind } from './model';
import s from './CRM.module.css';

interface Props {
  kind: Kind;
  rows: CrmRecord[];
  context: Context;
  /** The list is narrowed by a search or filters. */
  narrowed: boolean;
  book: string;
  /** Filter the list to records whose `field` is one of these values. */
  onPick: (field: string, value: string, op?: 'any' | 'is') => void;
}

type Tone = 'yellow' | 'lime' | 'sky' | 'pink' | 'violet' | 'orange';

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
const WEEK = 7 * 24 * 3600 * 1000;

function tally<T>(items: T[], key: (t: T) => string | null | undefined, weight: (t: T) => number = () => 1) {
  const m = new Map<string, number>();
  for (const t of items) {
    const k = key(t);
    if (k) m.set(k, (m.get(k) ?? 0) + weight(t));
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function Bento({ kind, rows, context, narrowed, book, onPick }: Props) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('crm.insights') !== 'off'; } catch { return true; }
  });
  const toggle = () => {
    setOpen(!open);
    try { localStorage.setItem('crm.insights', open ? 'off' : 'on'); } catch { /* per-viewer convenience only */ }
  };
  const scope = narrowed ? 'in this view' : 'in total';
  const recent = rows.filter((r) => Date.now() - new Date(r.created_at).getTime() < WEEK).length;
  const companyName = (id: string) => context.companies.find((c) => c.id === id)?.name ?? 'Unknown company';

  let tiles: ReactNode;
  if (kind === 'contacts') {
    const list = rows as Contact[];
    const withEmail = list.filter((c) => c.email).length;
    const linked = list.filter((c) => c.company_id).length;
    tiles = (
      <>
        <Stat tone="yellow" label={`Contacts ${scope}`} value={list.length.toLocaleString()} note={recent ? `+${recent} this week` : 'None added this week'} />
        <Meter tone="lime" label="Have an email" n={withEmail} of={list.length} />
        <Meter tone="sky" label="Linked to a company" n={linked} of={list.length} />
        <Stat tone="pink" label="Companies reached" value={new Set(list.map((c) => c.company_id).filter(Boolean)).size.toLocaleString()} note="with at least one contact here" />
        <Bars wide title="Lifecycle stage" entries={tally(list, (c) => c.lifecycle_stage)} label={humanize} onPick={(v) => onPick('lifecycle_stage', v)} empty="No lifecycle stages set yet." />
        <Bars wide tone="violet" title="Top companies by contacts" entries={tally(list, (c) => c.company_id).slice(0, 6)} label={companyName} onPick={(v) => onPick('company_id', v)} empty="No contacts are linked to companies yet." />
      </>
    );
  } else if (kind === 'companies') {
    const list = rows as Company[];
    const perCompany = new Map<string, number>();
    for (const c of context.contacts) if (c.company_id) perCompany.set(c.company_id, (perCompany.get(c.company_id) ?? 0) + 1);
    const withContacts = list.filter((c) => perCompany.has(c.id)).length;
    const top = list.filter((c) => perCompany.has(c.id)).sort((a, b) => perCompany.get(b.id)! - perCompany.get(a.id)!).slice(0, 6);
    const max = top.length ? perCompany.get(top[0].id)! : 1;
    tiles = (
      <>
        <Stat tone="yellow" label={`Companies ${scope}`} value={list.length.toLocaleString()} note={recent ? `+${recent} this week` : 'None added this week'} />
        <Meter tone="lime" label="Have at least one contact" n={withContacts} of={list.length} />
        <Meter tone="sky" label="Have a website" n={list.filter((c) => c.domain).length} of={list.length} />
        <Meter tone="pink" label="Have LinkedIn" n={list.filter((c) => c.has_linkedin || c.linkedin_url).length} of={list.length} />
        <Bars wide title="Prospect type" entries={tally(list, (c) => c.prospect_type?.trim()).slice(0, 6)} onPick={(v) => onPick('prospect_type', v, 'is')} empty="No prospect types set yet." />
        <Tile wide tone="violet" title="Most contacts">
          {top.length ? (
            <ol className={s.bentoList}>
              {top.map((c) => (
                <li key={c.id}>
                  <Link to={`/crm/companies/${c.id}${book}`}>{c.name}</Link>
                  <span className={s.bentoTrack}><span className={s.bentoFill} style={{ '--w': `${pct(perCompany.get(c.id)!, max)}%` } as CSSProperties} /></span>
                  <strong>{perCompany.get(c.id)}</strong>
                </li>
              ))}
            </ol>
          ) : <p className={s.bentoEmpty}>No contacts are linked to these companies yet.</p>}
        </Tile>
      </>
    );
  } else {
    const list = rows as Deal[];
    const stage = (id: string) => context.stages.find((st) => st.id === id);
    const open = list.filter((d) => !stage(d.stage_id)?.is_won && !stage(d.stage_id)?.is_lost);
    const won = list.filter((d) => stage(d.stage_id)?.is_won);
    const currency = list[0]?.currency ?? 'EUR';
    const sum = (ds: Deal[]) => ds.reduce((a, d) => a + Number(d.value || 0), 0);
    tiles = (
      <>
        <Stat tone="yellow" label="Open pipeline" value={formatMoney(sum(open), currency)} note={`${open.length} open ${open.length === 1 ? 'deal' : 'deals'}`} />
        <Stat tone="lime" label="Won" value={formatMoney(sum(won), currency)} note={`${won.length} won ${won.length === 1 ? 'deal' : 'deals'}`} />
        <Meter tone="sky" label="Win rate (closed deals)" n={won.length} of={list.filter((d) => stage(d.stage_id)?.is_won || stage(d.stage_id)?.is_lost).length} />
        <Stat tone="pink" label="Average deal" value={list.length ? formatMoney(sum(list) / list.length, currency) : '—'} note={`${list.length} ${list.length === 1 ? 'deal' : 'deals'} ${scope}`} />
        <Bars full title="Value by stage" entries={tally(list, (d) => d.stage_id, (d) => Number(d.value || 0))} label={(id) => stage(id)?.name ?? 'Unknown stage'}
          format={(n) => formatMoney(n, currency)} onPick={(v) => onPick('stage_id', v)} empty="No deals yet." />
      </>
    );
  }

  return (
    <section className={s.bento} aria-label="Insights">
      <div className={s.bentoHead}>
        <h2>Insights</h2>
        <span className={s.hint}>{narrowed ? 'For the records in this view.' : 'Select a bar to filter the list.'}</span>
        <button className={s.linkButton} onClick={toggle} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {open && rows.length > 0 && <div className={s.bentoGrid}>{tiles}</div>}
    </section>
  );
}

function Tile({ tone, title, wide, full, children }: { tone?: Tone; title: string; wide?: boolean; full?: boolean; children: ReactNode }) {
  return (
    <div className={`${s.tile} ${tone ? s[`tone-${tone}`] : ''} ${wide ? s.tileWide : ''} ${full ? s.tileFull : ''}`}>
      <span className={s.tileLabel}>{title}</span>
      {children}
    </div>
  );
}

function Stat({ tone, label, value, note }: { tone: Tone; label: string; value: string; note: string }) {
  return (
    <Tile tone={tone} title={label}>
      <strong className={s.tileValue}>{value}</strong>
      <span className={s.tileNote}>{note}</span>
    </Tile>
  );
}

function Meter({ tone, label, n, of }: { tone: Tone; label: string; n: number; of: number }) {
  const p = pct(n, of);
  return (
    <Tile tone={tone} title={label}>
      <strong className={s.tileValue}>{p}%</strong>
      <span className={s.meter} role="meter" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span style={{ '--w': `${p}%` } as CSSProperties} />
      </span>
      <span className={s.tileNote}>{n.toLocaleString()} of {of.toLocaleString()}</span>
    </Tile>
  );
}

function Bars({ title, entries, label = (k) => k, format = (n) => n.toLocaleString(), onPick, empty, wide, full, tone }: {
  title: string; entries: [string, number][]; label?: (k: string) => string; format?: (n: number) => string;
  onPick: (value: string) => void; empty: string; wide?: boolean; full?: boolean; tone?: Tone;
}) {
  const max = entries[0]?.[1] || 1;
  return (
    <Tile title={title} wide={wide} full={full} tone={tone}>
      {entries.length ? (
        <div className={s.bars}>
          {entries.map(([k, n], i) => (
            <button key={k} type="button" className={s.bar} onClick={() => onPick(k)} title={`Show only ${label(k)}`} style={{ '--i': i } as CSSProperties}>
              <span className={s.barLabel}>{label(k)}</span>
              <span className={s.bentoTrack}><span className={s.bentoFill} style={{ '--w': `${Math.max(3, pct(n, max))}%` } as CSSProperties} /></span>
              <strong>{format(n)}</strong>
            </button>
          ))}
        </div>
      ) : <p className={s.bentoEmpty}>{empty}</p>}
    </Tile>
  );
}
