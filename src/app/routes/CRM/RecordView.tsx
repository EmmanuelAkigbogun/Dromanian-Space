import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from '@/components/ui/Dialog';
import { platform, result, errorText } from '@/features/platform/client';
import { CellEditor } from './RecordTable';
import {
  TABLES, displayValue, formatDate, personName, readValue,
  type Column, type Company, type CrmRecord, type Kind, type Person,
} from './model';
import s from './CRM.module.css';

interface Props {
  ws: string;
  userId: string;
  kind: Kind;
  record: CrmRecord;
  columns: Column[];
  people: Person[];
  editable: boolean;
  suggestions: Record<string, string[]>;
  onSave: (record: CrmRecord, column: Column, value: unknown) => Promise<void>;
  book: string;
}

const href = (v: string) => (/^https?:\/\//i.test(v) ? v : `https://${v}`);

export function RecordView({ ws, userId, kind, record, columns, people, editable, suggestions, onSave, book }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const table = TABLES[kind];
  const key = ['platform', ws, userId, 'crm', 'record', record.id];

  const detail = useQuery({
    queryKey: key,
    queryFn: async () => {
      const [notes, activity, links] = await Promise.all([
        result(platform.from('crm_notes').select('*').eq('workspace_id', ws).eq('record_id', record.id).order('created_at', { ascending: false }).limit(100)),
        result(platform.from('crm_activity').select('*').eq('workspace_id', ws).eq('record_id', record.id).order('created_at', { ascending: false }).limit(50)),
        result(platform.from('crm_links').select('*').eq('workspace_id', ws).eq(kind === 'companies' ? 'company_id' : kind === 'contacts' ? 'contact_id' : 'deal_id', record.id)),
      ]);
      const related = kind === 'deals' ? { contacts: [], deals: [] } : {
        contacts: kind === 'companies' ? await result(platform.from('crm_contacts').select('id,name,email,title').eq('workspace_id', ws).eq('company_id', record.id).order('name').limit(100)) : [],
        deals: await result(platform.from('crm_deals').select('id,name,value,currency').eq('workspace_id', ws).eq(kind === 'companies' ? 'company_id' : 'contact_id', record.id).limit(100)),
      };
      return { notes, activity, links, related };
    },
  });

  const addNote = async () => {
    if (!note.trim()) return;
    setError('');
    try {
      await result(platform.from('crm_notes').insert({ workspace_id: ws, record_type: table, record_id: record.id, body: note.trim(), author_id: userId }));
      setNote('');
      await detail.refetch();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const deleteNote = async (id: string) => {
    await result(platform.from('crm_notes').delete().eq('id', id));
    await detail.refetch();
  };

  type Event = { id: string; at: string; who: string | null; body: string; note?: boolean };
  const events: Event[] = [
    ...(detail.data?.notes ?? []).map((n: { id: string; created_at: string; author_id: string; body: string }) => ({ id: n.id, at: n.created_at, who: n.author_id, body: n.body, note: true })),
    ...(detail.data?.activity ?? []).map((a: { id: string; created_at: string; actor_id: string | null; action: string; changes: Record<string, unknown> | null }) => ({
      id: a.id, at: a.created_at, who: a.actor_id,
      body: a.action === 'insert' ? 'Created the record' : a.action === 'delete' ? 'Deleted the record' : `Changed ${Object.keys(a.changes ?? {}).map((k) => columns.find((c) => c.key === k)?.label ?? k).join(', ') || 'details'}`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const who = (id: string | null) => personName(people.find((p) => p.id === id));
  const notesColumn: Column = { key: 'notes', label: 'Notes', type: 'long_text', field: 'notes', editable: true, width: 200, shown: true };

  return (
    <div className={s.record}>
      <aside className={s.panel}>
        <h2>Details</h2>
        {columns.map((c) => {
          const canEdit = editable && c.editable;
          const value = displayValue(record, c);
          return (
            <div key={c.key} className={s.prop}>
              <span className={s.propLabel}>{c.label}</span>
              {editing === c.key ? (
                <CellEditor record={record} column={c} suggestions={suggestions[c.key]}
                  onDone={async (v, changed) => { setEditing(null); if (changed) await onSave(record, c, v); }} />
              ) : c.type === 'checkbox' ? (
                <label className={s.propValue}>
                  <input type="checkbox" disabled={!canEdit} checked={readValue(record, c) === true}
                    onChange={() => void onSave(record, c, !(readValue(record, c) === true))} /> {value}
                </label>
              ) : (
                <span className={`${s.propValue} ${canEdit ? s.cellEditable : ''}`} onClick={() => canEdit && setEditing(c.key)} title={value}>
                  {value && c.type === 'url' ? (
                    <a className={s.extLink} href={href(value.split(/\s*;\s*|\s+/)[0])} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{value}</a>
                  ) : value || <span className={s.hint}>{canEdit ? 'Add…' : '—'}</span>}
                </span>
              )}
            </div>
          );
        })}
        <div className={s.prop} style={{ alignItems: 'start' }}>
          <span className={s.propLabel}>Notes</span>
          {editing === 'notes' ? (
            <CellEditor record={record} column={notesColumn} onDone={async (v, changed) => { setEditing(null); if (changed) await onSave(record, notesColumn, v ?? ''); }} />
          ) : (
            <span className={`${s.propValue} ${editable ? s.cellEditable : ''}`} style={{ whiteSpace: 'pre-wrap' }} onClick={() => editable && setEditing('notes')}>
              {record.notes || <span className={s.hint}>{editable ? 'Add…' : '—'}</span>}
            </span>
          )}
        </div>
      </aside>

      <div className={s.main}>
        <section className={s.panel}>
          <h2>Timeline</h2>
          <div className={s.composer}>
            <textarea aria-label="Add a note" placeholder="Add a note: a call, a meeting, what was agreed…" value={note} onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void addNote(); }} />
            <div className={s.choiceRow}>
              <button className={s.primary} disabled={!note.trim()} onClick={() => void addNote()}>Add note</button>
              <span className={s.hint}>Ctrl+Enter</span>
            </div>
          </div>
          {error && <p className={s.error}>{error}</p>}
          <div className={s.timeline}>
            {events.map((e) => (
              <div key={e.id} className={s.event}>
                <span className={e.note ? s.eventNote : s.hint}>{e.body}</span>
                <span className={s.eventMeta}>
                  {who(e.who)} · {new Date(e.at).toLocaleString()}
                  {e.note && e.who === userId && <button className={s.ghost} style={{ padding: '0 4px' }} onClick={() => void deleteNote(e.id)}>Delete</button>}
                </span>
              </div>
            ))}
            {!events.length && !detail.isPending && <p className={s.hint}>Nothing yet.</p>}
          </div>
        </section>

        {kind !== 'deals' && (
          <section className={s.panel}>
            <h2>Related</h2>
            <div className={s.related}>
              {detail.data?.related.contacts.map((c: { id: string; name: string; title: string | null }) => (
                <Link key={c.id} to={`/crm/contacts/${c.id}${book}`}>{c.name}{c.title ? ` · ${c.title}` : ''}</Link>
              ))}
              {detail.data?.related.deals.map((d: { id: string; name: string; value: number; currency: string }) => (
                <Link key={d.id} to={`/crm/deals/${d.id}${book}`}>Deal: {d.name} · {d.currency} {Number(d.value).toLocaleString()}</Link>
              ))}
              {!detail.data?.related.contacts.length && !detail.data?.related.deals.length && <span className={s.hint}>No contacts or deals linked yet.</span>}
            </div>
          </section>
        )}

        <section className={s.panel}>
          <h2>Files, tasks and conversations</h2>
          <div className={s.related}>
            {detail.data?.links.map((l: { id: string; item_id: string | null; task_id: string | null; channel_id: string | null }) => (
              <Link key={l.id} to={l.item_id ? `/drive/item/${l.item_id}` : l.task_id ? `/tasks/${l.task_id}` : `/channels/${l.channel_id}`}>
                {l.item_id ? (kind === 'companies' && (record as Company).drive_folder_id === l.item_id ? 'Drive folder' : 'Linked file') : l.task_id ? ((record as Company).brand_task_id === l.task_id ? 'Brand files task' : 'Linked task') : 'Linked conversation'}
              </Link>
            ))}
          </div>
          <LinkResource ws={ws} userId={userId} kind={kind} id={record.id} onSaved={() => detail.refetch()} />
          <p className={s.hint}>Created {formatDate(record.created_at)} · Last updated {formatDate(record.updated_at)}</p>
        </section>
      </div>
    </div>
  );
}

function LinkResource({ ws, userId, kind, id, onSaved }: { ws: string; userId: string; kind: Kind; id: string; onSaved: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const choices = useQuery({
    queryKey: ['platform', ws, userId, 'crm-link-options'],
    enabled: open,
    queryFn: async () => {
      const [files, tasks, channels] = await Promise.all([
        result(platform.rpc('drive_list', { p_workspace_id: ws, p_view: 'all', p_limit: 100 })),
        result(platform.from('tasks').select('id,title').eq('workspace_id', ws).is('deleted_at', null).limit(100)),
        result(platform.from('channels').select('id,name').eq('workspace_id', ws).limit(100)),
      ]);
      return { files, tasks, channels } as { files: { id: string; name: string }[]; tasks: { id: string; title: string }[]; channels: { id: string; name: string }[] };
    },
  });
  const save = async () => {
    const [type, targetId] = target.split(':');
    try {
      await result(platform.from('crm_links').insert({
        workspace_id: ws, created_by: userId,
        ...(kind === 'companies' ? { company_id: id } : kind === 'contacts' ? { contact_id: id } : { deal_id: id }),
        ...(type === 'file' ? { item_id: targetId } : type === 'task' ? { task_id: targetId } : { channel_id: targetId }),
      }));
      await onSaved();
      setOpen(false);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      <button className={s.button} style={{ alignSelf: 'start' }} onClick={() => setOpen(true)}>Link a file, task or conversation</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Link an existing resource">
        <div className={s.form}>
          <p className={s.hint}>Only people with access to the resource see the link. Linking grants no access.</p>
          <select className={s.input} aria-label="Resource" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {choices.data?.files.map((f) => <option key={f.id} value={`file:${f.id}`}>File: {f.name}</option>)}
            {choices.data?.tasks.map((t) => <option key={t.id} value={`task:${t.id}`}>Task: {t.title}</option>)}
            {choices.data?.channels.map((c) => <option key={c.id} value={`channel:${c.id}`}>Channel: {c.name}</option>)}
          </select>
          {(error || choices.error) && <p className={s.error}>{error || errorText(choices.error)}</p>}
          <button className={s.primary} disabled={!target} onClick={() => void save()}>Link</button>
        </div>
      </Dialog>
    </>
  );
}
