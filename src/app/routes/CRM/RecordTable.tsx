import { useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  AGGREGATES, aggregate, aggregatesFor, displayValue, readValue,
  type Column, type CrmRecord, type Kind, type ViewState,
} from './model';
import s from './CRM.module.css';

interface Props {
  kind: Kind;
  records: CrmRecord[];
  columns: Column[];
  view: ViewState;
  onView: (view: ViewState) => void;
  canEdit: (record: CrmRecord) => boolean;
  onSave: (record: CrmRecord, column: Column, value: unknown) => Promise<void>;
  selected: Set<string>;
  onSelect: (ids: Set<string>) => void;
  /** ?client=… so links stay in the same CRM. */
  book: string;
  suggestions: Record<string, string[]>;
}

const href = (v: string) => (/^https?:\/\//i.test(v) ? v : `https://${v}`);

/** A spreadsheet of records: click a cell to edit it, a header to sort, a footer to calculate. */
export function RecordTable({ kind, records, columns, view, onView, canEdit, onSave, selected, onSelect, book, suggestions }: Props) {
  const [editing, setEditing] = useState<{ id: string; key: string } | null>(null);
  const allSelected = records.length > 0 && records.every((r) => selected.has(r.id));

  const sortBy = (column: Column) => {
    const desc = view.sort === column.field ? !view.sortDesc : false;
    onView({ ...view, sort: column.field, sortDesc: desc });
  };
  const setAggregate = (column: Column, op: string) =>
    onView({ ...view, columns: { ...view.columns, [column.key]: { ...view.columns[column.key], aggregate: op || undefined } } });

  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <colgroup>
          <col style={{ width: 36 }} />
          {columns.map((c) => <col key={c.key} style={{ width: c.width }} />)}
        </colgroup>
        <thead>
          <tr>
            <th className={`${s.check} ${s.stickyCol}`}>
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allSelected}
                onChange={() => onSelect(allSelected ? new Set() : new Set(records.map((r) => r.id)))}
              />
            </th>
            {columns.map((c, i) => (
              <th
                key={c.key}
                className={i === 0 ? s.stickyCol : undefined}
                style={i === 0 ? { left: 36 } : undefined}
                onClick={() => sortBy(c)}
                aria-sort={view.sort === c.field ? (view.sortDesc ? 'descending' : 'ascending') : undefined}
                title={`Sort by ${c.label}`}
              >
                {c.label}
                {view.sort === c.field && (view.sortDesc ? ' ↓' : ' ↑')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id}>
              <td className={`${s.check} ${s.stickyCol}`}>
                <input
                  type="checkbox"
                  aria-label={`Select ${r.name}`}
                  checked={selected.has(r.id)}
                  onChange={() => {
                    const next = new Set(selected);
                    if (next.has(r.id)) next.delete(r.id);
                    else next.add(r.id);
                    onSelect(next);
                  }}
                />
              </td>
              {columns.map((c, i) => {
                const editable = c.editable && canEdit(r);
                const isEditing = editing?.id === r.id && editing.key === c.key;
                return (
                  <td
                    key={c.key}
                    className={`${s.cell} ${editable ? s.cellEditable : ''} ${i === 0 ? s.stickyCol : ''}`}
                    style={i === 0 ? { left: 36 } : undefined}
                    onClick={() => editable && !isEditing && c.type !== 'checkbox' && setEditing({ id: r.id, key: c.key })}
                    title={displayValue(r, c)}
                  >
                    {isEditing ? (
                      <CellEditor
                        record={r}
                        column={c}
                        suggestions={suggestions[c.key]}
                        onDone={async (value, changed) => {
                          setEditing(null);
                          if (changed) await onSave(r, c, value);
                        }}
                      />
                    ) : i === 0 ? (
                      <div className={s.nameCell}>
                        <Link className={s.nameLink} to={`/crm/${kind}/${r.id}${book}`} onClick={(e) => e.stopPropagation()}>
                          {r.name}
                        </Link>
                        <Link className={s.open} to={`/crm/${kind}/${r.id}${book}`} onClick={(e) => e.stopPropagation()}>
                          Open
                        </Link>
                      </div>
                    ) : (
                      <CellView record={r} column={c} editable={editable} onToggle={(v) => void onSave(r, c, v)} />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className={`${s.check} ${s.stickyCol}`} />
            {columns.map((c, i) => {
              const op = view.columns[c.key]?.aggregate ?? (i === 0 ? 'count' : '');
              return (
                <td key={c.key} className={i === 0 ? s.stickyCol : undefined} style={i === 0 ? { left: 36 } : undefined}>
                  {i === 0 ? (
                    `${records.length} ${records.length === 1 ? 'record' : 'records'}`
                  ) : (
                    <select aria-label={`Calculate ${c.label}`} value={op} onChange={(e) => setAggregate(c, e.target.value)}>
                      <option value="">{op ? '' : 'Calculate'}</option>
                      {aggregatesFor(c.type).map((a) => (
                        <option key={a} value={a}>
                          {op === a ? `${AGGREGATES[a]}: ${aggregate(records, c, a)}` : AGGREGATES[a]}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              );
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function CellView({ record, column, editable, onToggle }: { record: CrmRecord; column: Column; editable: boolean; onToggle: (v: boolean) => void }) {
  const value = readValue(record, column);
  if (column.type === 'checkbox') {
    const on = value === true || value === 'true';
    return (
      <label onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={on} disabled={!editable} onChange={() => onToggle(!on)} aria-label={column.label} />{' '}
        <span className={on ? s.yes : s.no}>{on ? 'Yes' : 'No'}</span>
      </label>
    );
  }
  const text = displayValue(record, column);
  if (!text) return null;
  if (column.type === 'url') {
    const first = text.split(/\s*;\s*|\s+/)[0];
    return (
      <a className={s.extLink} href={href(first)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
        {text.replace(/^https?:\/\/(www\.)?/i, '')}
      </a>
    );
  }
  if (column.type === 'email') return <a className={s.extLink} href={`mailto:${text}`} onClick={(e) => e.stopPropagation()}>{text}</a>;
  if (column.type === 'phone') return <a className={s.extLink} href={`tel:${text.replace(/\s/g, '')}`} onClick={(e) => e.stopPropagation()}>{text}</a>;
  if (column.type === 'enum' || column.suggest) return <span className={s.badge}>{text}</span>;
  return <>{text}</>;
}

export function CellEditor({ record, column, suggestions, onDone }: {
  record: CrmRecord;
  column: Column;
  suggestions?: string[];
  onDone: (value: unknown, changed: boolean) => void;
}) {
  const initial = readValue(record, column);
  const start = Array.isArray(initial) ? initial.join(', ') : initial === null ? '' : String(initial);
  const [value, setValue] = useState(column.type === 'date' ? start.slice(0, 10) : start);
  const finish = (v = value) => {
    const next: unknown =
      column.type === 'number' || column.type === 'money' ? (v === '' ? null : Number(v))
        : column.type === 'tags' ? v.split(',').map((t) => t.trim()).filter(Boolean)
          : v.trim() === '' ? null : v.trim();
    onDone(next, v !== start);
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && column.type !== 'long_text') finish();
    if (e.key === 'Escape') onDone(initial, false);
  };
  if (column.options && (column.type === 'enum' || column.type === 'person' || column.type === 'company' || column.type === 'contact')) {
    return (
      <select
        className={s.cellEditor}
        autoFocus
        value={value}
        onChange={(e) => finish(e.target.value)}
        onBlur={() => onDone(initial, false)}
        onKeyDown={keys}
      >
        {column.key !== 'owner_id' && column.key !== 'stage_id' && <option value="">None</option>}
        {column.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  const listId = suggestions?.length ? `suggest-${column.key}` : undefined;
  return (
    <>
      <input
        className={s.cellEditor}
        autoFocus
        type={column.type === 'number' || column.type === 'money' ? 'number' : column.type === 'date' ? 'date' : column.type === 'email' ? 'email' : 'text'}
        value={value}
        list={listId}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish()}
        onKeyDown={keys}
      />
      {listId && (
        <datalist id={listId}>
          {suggestions!.map((v) => <option key={v} value={v} />)}
        </datalist>
      )}
    </>
  );
}
