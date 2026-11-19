// Small shared pieces of the CRM's HubSpot-style layout: dropdown menus,
// avatars, collapsible cards, quick filters and the editable property list.
import { useRef, useState, type ReactNode } from 'react';
import { Floating } from '@/lib/overlay/Floating';
import { CellEditor } from './RecordTable';
import { displayValue, readValue, type Column, type CrmRecord, type Kind, type Rule, type ViewState } from './model';
import s from './CRM.module.css';

export const initialsOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

const AVATAR_TONES = ['sky', 'teal', 'violet', 'amber', 'rose', 'emerald', 'orange', 'fuchsia'];
const toneOf = (name: string) => AVATAR_TONES[[...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR_TONES.length];

export function Avatar({ name, kind, size = 'sm' }: { name: string; kind: Kind; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span aria-hidden="true" className={`${s.avatar} ${s[`avatar-${size}`]} ${kind === 'companies' ? s.avatarSquare : ''} ${s[`stage-${toneOf(name)}`] ?? ''}`}>
      {kind === 'deals' ? '€' : initialsOf(name)}
    </span>
  );
}

/** A button that opens a floating menu; items close it when chosen. */
export function Menu({ label, children, primary, align = 'end', className }: {
  label: ReactNode; children: (close: () => void) => ReactNode; primary?: boolean; align?: 'start' | 'end'; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button" className={className ?? (primary ? s.primary : s.button)} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label} <span aria-hidden="true" className={s.caret}>▾</span>
      </button>
      <Floating open={open} anchor={anchor} placement={align === 'end' ? 'bottom-end' : 'bottom-start'} offset={4} onDismiss={() => setOpen(false)} role="menu" className={s.menu}>
        {children(() => setOpen(false))}
      </Floating>
    </>
  );
}

export function MenuItem({ children, onClick, danger, disabled, hint }: { children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }) {
  return (
    <button type="button" role="menuitem" className={`${s.menuItem} ${danger ? s.danger : ''}`} disabled={disabled} onClick={onClick} title={hint}>
      {children}
    </button>
  );
}

/** A card with a header that folds its body away, like HubSpot's sidebar cards. */
export function Card({ title, count, action, children, defaultOpen = true }: {
  title: string; count?: number; action?: ReactNode; children: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={s.card2}>
      <header className={s.card2Head}>
        <button type="button" className={s.card2Toggle} aria-expanded={open} onClick={() => setOpen(!open)}>
          <span aria-hidden="true" className={`${s.chevron} ${open ? s.chevronOpen : ''}`}>›</span>
          {title}{count !== undefined && <span className={s.card2Count}>({count})</span>}
        </button>
        {action}
      </header>
      {open && <div className={s.card2Body}>{children}</div>}
    </section>
  );
}

/** "Owner ▾"-style quick filter over a choice column: ticks values on an "is any of" rule. */
export function QuickFilter({ column, view, onView, extra }: { column: Column; view: ViewState; onView: (v: ViewState) => void; extra?: { value: string; label: string }[] }) {
  const index = view.rules.findIndex((r) => r.field === column.key && r.op === 'any');
  const chosen = index >= 0 && Array.isArray(view.rules[index].value) ? (view.rules[index].value as string[]) : [];
  const options = [...(extra ?? []), ...(column.options ?? [])];
  const toggle = (value: string) => {
    const next = chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value];
    const rule: Rule = { field: column.key, op: 'any', value: next };
    const rules = index >= 0
      ? (next.length ? view.rules.map((r, i) => (i === index ? rule : r)) : view.rules.filter((_, i) => i !== index))
      : [...view.rules, rule];
    onView({ ...view, rules });
  };
  const summary = chosen.length === 0 ? '' : chosen.length === 1 ? `: ${options.find((o) => o.value === chosen[0])?.label ?? '1'}` : ` (${chosen.length})`;
  return (
    <Menu align="start" className={`${s.filterButton} ${chosen.length ? s.filterButtonOn : ''}`} label={`${column.label}${summary}`}>
      {() => (
        <>
          {options.map((o) => (
            <label key={o.value} className={s.menuCheck}>
              <input type="checkbox" checked={chosen.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
          {!options.length && <span className={s.hint} style={{ padding: 8 }}>Nothing to choose yet.</span>}
          {chosen.length > 0 && <MenuItem onClick={() => onView({ ...view, rules: view.rules.filter((_, i) => i !== index) })}>Clear</MenuItem>}
        </>
      )}
    </Menu>
  );
}

const href = (v: string) => (/^https?:\/\//i.test(v) ? v : `https://${v}`);

/** Label-over-value properties; select a value to edit it in place. */
export function PropertyList({ record, columns, editable, suggestions, onSave }: {
  record: CrmRecord; columns: Column[]; editable: boolean; suggestions: Record<string, string[]>;
  onSave: (record: CrmRecord, column: Column, value: unknown) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <dl className={s.props}>
      {columns.map((c) => {
        const canEdit = editable && c.editable;
        const value = displayValue(record, c);
        let body: ReactNode;
        if (editing === c.key) {
          body = <CellEditor record={record} column={c} suggestions={suggestions[c.key]} onDone={async (v, changed) => { setEditing(null); if (changed) await onSave(record, c, v); }} />;
        } else if (c.type === 'checkbox') {
          const on = readValue(record, c) === true || readValue(record, c) === 'true';
          body = (
            <label className={s.propCheck}>
              <input type="checkbox" disabled={!canEdit} checked={on} onChange={() => void onSave(record, c, !on)} /> {on ? 'Yes' : 'No'}
            </label>
          );
        } else if (value && (c.type === 'url' || c.type === 'email' || c.type === 'phone')) {
          const first = value.split(/\s*;\s*|\s+/)[0];
          const link = c.type === 'url' ? href(first) : c.type === 'email' ? `mailto:${value}` : `tel:${value.replace(/\s/g, '')}`;
          body = (
            <span className={s.propLinkRow}>
              <a className={s.extLink} href={link} {...(c.type === 'url' ? { target: '_blank', rel: 'noopener noreferrer' } : {})} title={value}>
                {c.type === 'url' ? value.replace(/^https?:\/\/(www\.)?/i, '') : value}
              </a>
              {canEdit && <button type="button" className={s.pencil} aria-label={`Edit ${c.label}`} onClick={() => setEditing(c.key)}>✎</button>}
            </span>
          );
        } else if (canEdit) {
          body = (
            <button type="button" className={s.propEdit} onClick={() => setEditing(c.key)} aria-label={`Edit ${c.label}`} title={value}>
              <span className={c.type === 'long_text' ? s.preWrap : undefined}>{value || <span className={s.hint}>—</span>}</span>
              <span aria-hidden="true" className={s.pencilShow}>✎</span>
            </button>
          );
        } else {
          body = <span className={s.propStatic} title={value}>{value || <span className={s.hint}>—</span>}</span>;
        }
        return (
          <div key={c.key} className={s.propItem}>
            <dt>{c.label}</dt>
            <dd>{body}</dd>
          </div>
        );
      })}
    </dl>
  );
}
