// A record's page, laid out like HubSpot's: identity, quick actions and
// properties on the left; Overview and Activities in the middle;
// associations (company, contacts, deals, files) in cards on the right.
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from '@/components/ui/Dialog';
import { platform, result, errorText } from '@/features/platform/client';
import {
  TABLES, displayValue, formatDate, formatMoney, personName,
  type Column, type Company, type Contact, type CrmRecord, type Deal, type Kind, type Person,
} from './model';
import { Avatar, Card, Menu, PropertyList } from './ui';
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
  /** Items for the record's Actions menu. */
  actions: (close: () => void) => ReactNode;
}

const href = (v: string) => (/^https?:\/\//i.test(v) ? v : `https://${v}`);
const KIND_LABEL: Record<Kind, string> = { companies: 'Company', contacts: 'Contact', deals: 'Deal' };

type Event = { id: string; at: string; who: string | null; body: string; note?: boolean };

export function RecordView({ ws, userId, kind, record, columns, people, editable, suggestions, onSave, book, actions }: Props) {
  const [tab, setTab] = useState<'overview' | 'activities'>('overview');
  const [activityFilter, setActivityFilter] = useState<'all' | 'notes' | 'changes'>('all');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const table = TABLES[kind];
  const key = ['platform', ws, userId, 'crm', 'record', record.id];
  const fields = record as unknown as Record<string, unknown>;
  const text = (k: string) => (typeof fields[k] === 'string' && fields[k] ? String(fields[k]) : '');
  const companyId = kind === 'companies' ? null : text('company_id') || null;
  const contactId = kind === 'deals' ? text('contact_id') || null : null;

  const detail = useQuery({
    queryKey: key,
    queryFn: async () => {
      const [notes, activity, links, contacts, deals, company, contact] = await Promise.all([
        result(platform.from('crm_notes').select('*').eq('workspace_id', ws).eq('record_id', record.id).order('created_at', { ascending: false }).limit(100)),
        result(platform.from('crm_activity').select('*').eq('workspace_id', ws).eq('record_id', record.id).order('created_at', { ascending: false }).limit(50)),
        result(platform.from('crm_links').select('*').eq('workspace_id', ws).eq(kind === 'companies' ? 'company_id' : kind === 'contacts' ? 'contact_id' : 'deal_id', record.id)),
        kind === 'companies'
          ? result(platform.from('crm_contacts').select('id,name,email,title,phone').eq('workspace_id', ws).eq('company_id', record.id).order('name').limit(200))
          : Promise.resolve([] as Pick<Contact, 'id' | 'name' | 'email' | 'title' | 'phone'>[]),
        kind === 'deals'
          ? Promise.resolve([] as Pick<Deal, 'id' | 'name' | 'value' | 'currency'>[])
          : result(platform.from('crm_deals').select('id,name,value,currency').eq('workspace_id', ws).eq(kind === 'companies' ? 'company_id' : 'contact_id', record.id).limit(100)),
        companyId
          ? result(platform.from('crm_companies').select('id,name,domain,industry').eq('workspace_id', ws).eq('id', companyId).maybeSingle())
          : Promise.resolve(null),
        contactId
          ? result(platform.from('crm_contacts').select('id,name,email,title').eq('workspace_id', ws).eq('id', contactId).maybeSingle())
          : Promise.resolve(null),
      ]);
      return { notes, activity, links, contacts, deals, company, contact };
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
    if (!window.confirm('Delete this note?')) return;
    await result(platform.from('crm_notes').delete().eq('id', id));
    await detail.refetch();
  };

  const events: Event[] = useMemo(() => [
    ...(detail.data?.notes ?? []).map((n: { id: string; created_at: string; author_id: string; body: string }) => ({ id: n.id, at: n.created_at, who: n.author_id, body: n.body, note: true })),
    ...(detail.data?.activity ?? []).map((a: { id: string; created_at: string; actor_id: string | null; action: string; changes: Record<string, unknown> | null }) => ({
      id: a.id, at: a.created_at, who: a.actor_id,
      body: a.action === 'insert' ? `Created this ${KIND_LABEL[kind].toLowerCase()}` : a.action === 'delete' ? 'Deleted the record'
        : `Updated ${Object.keys(a.changes ?? {}).filter((k) => k !== 'updated_at').map((k) => columns.find((c) => c.key === k)?.label ?? k).join(', ') || 'details'}`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)), [detail.data, columns, kind]);

  const who = (id: string | null) => personName(people.find((p) => p.id === id));
  const kindLabel = KIND_LABEL[kind];
  const email = text('email');
  const phone = text('phone');
  const domain = text('domain');
  const linkedin = text('linkedin_url') || String((record.custom as Record<string, unknown> | null)?.linkedin_url ?? '');
  const company = kind === 'companies' ? (record as Company) : null;
  const col = (k: string) => columns.find((c) => c.key === k);
  const show = (k: string) => { const c = col(k); return c ? displayValue(record, c) : ''; };

  const startNote = () => {
    setTab('activities');
    setActivityFilter('all');
    requestAnimationFrame(() => composer.current?.focus());
  };

  // Headline under the name.
  const subtitle: ReactNode = kind === 'contacts'
    ? <>{text('title')}{text('title') && detail.data?.company && ' at '}{detail.data?.company && <Link to={`/crm/companies/${detail.data.company.id}${book}`}>{detail.data.company.name}</Link>}</>
    : kind === 'companies'
      ? <>{domain && <a href={href(domain)} target="_blank" rel="noopener noreferrer">{domain.replace(/^https?:\/\/(www\.)?/i, '')}</a>}{domain && text('industry') && ' · '}{text('industry')}</>
      : <>{show('value')}{show('stage_id') && ` · ${show('stage_id')}`}</>;

  const highlights: { label: string; value: string }[] = kind === 'contacts'
    ? [
        { label: 'Create date', value: formatDate(record.created_at) },
        { label: 'Lifecycle stage', value: show('lifecycle_stage') || '—' },
        { label: 'Last activity', value: events[0] ? formatDate(events[0].at) : '—' },
        { label: 'Owner', value: who(record.owner_id) },
      ]
    : kind === 'companies'
      ? [
          { label: 'Contacts', value: String(detail.data?.contacts.length ?? '…') },
          { label: 'Deals', value: String(detail.data?.deals.length ?? '…') },
          { label: 'Sector', value: show('industry') || '—' },
          { label: 'Contact status', value: show('contact_status') || '—' },
        ]
      : [
          { label: 'Amount', value: show('value') || '—' },
          { label: 'Stage', value: show('stage_id') || '—' },
          { label: 'Close date', value: show('expected_close') || '—' },
          { label: 'Owner', value: who(record.owner_id) },
        ];

  const filtered = events.filter((e) => activityFilter === 'all' || (activityFilter === 'notes' ? e.note : !e.note));

  return (
    <div className={s.recordLayout}>
      {/* ── Left: identity, quick actions, properties ── */}
      <aside className={s.recordSide}>
        <div className={s.sideTop}>
          <Link className={s.backLink} to={`/crm/${kind}${book}`}>‹ {kind[0].toUpperCase() + kind.slice(1)}</Link>
          <Menu label="Actions">{actions}</Menu>
        </div>
        <div className={s.identity}>
          <Avatar name={record.name} kind={kind} size="lg" />
          <h1 className={s.identityName}>{record.name}</h1>
          {subtitle && <p className={s.identitySub}>{subtitle}</p>}
          {email && <a className={s.identityEmail} href={`mailto:${email}`}>{email}</a>}
        </div>
        <div className={s.actionRow} aria-label="Quick actions">
          <QuickAction icon="✎" label="Note" onClick={startNote} />
          <QuickAction icon="✉" label="Email" href={email ? `mailto:${email}` : undefined} />
          <QuickAction icon="☎" label="Call" href={phone ? `tel:${phone.replace(/\s/g, '')}` : undefined} />
          {kind === 'companies'
            ? <QuickAction icon="↗" label="Website" href={domain ? href(domain) : undefined} external />
            : <QuickAction icon="in" label="LinkedIn" href={linkedin ? href(linkedin) : undefined} external />}
          <QuickAction icon="✦" label="Ask AI" to={`/agents?crm=${record.id}&crm_kind=${kind}`} />
        </div>

        <Card title={`About this ${kindLabel.toLowerCase()}`}>
          <PropertyList record={record} columns={columns} editable={editable} suggestions={suggestions} onSave={onSave} />
          {!editable && <p className={s.hint}>Only the owner, the creator or an admin can edit this {kindLabel.toLowerCase()}.</p>}
        </Card>
        <Card title="Description">
          <PropertyList record={record} editable={editable} suggestions={suggestions} onSave={onSave}
            columns={[{ key: 'notes', label: 'Notes', type: 'long_text', field: 'notes', editable: true, width: 200, shown: true }]} />
        </Card>
        <p className={s.hint} style={{ padding: '0 4px' }}>Owned by {who(record.owner_id)} · Created {formatDate(record.created_at)} · Updated {formatDate(record.updated_at)}</p>
      </aside>

      {/* ── Middle: overview and activity ── */}
      <main className={s.recordMain}>
        <div className={s.tabs} role="tablist">
          <button role="tab" aria-selected={tab === 'overview'} className={`${s.tab} ${tab === 'overview' ? s.tabOn : ''}`} onClick={() => setTab('overview')}>Overview</button>
          <button role="tab" aria-selected={tab === 'activities'} className={`${s.tab} ${tab === 'activities' ? s.tabOn : ''}`} onClick={() => setTab('activities')}>
            Activities <span className={s.tabCount}>{events.length}</span>
          </button>
        </div>

        {tab === 'overview' ? (
          <div className={s.overview}>
            <section className={s.block}>
              <h2 className={s.blockTitle}>Data highlights</h2>
              <div className={s.highlights}>
                {highlights.map((h) => (
                  <div key={h.label} className={s.highlight}>
                    <span>{h.label}</span>
                    <strong title={h.value}>{h.value}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className={s.block}>
              <div className={s.blockHead}>
                <h2 className={s.blockTitle}>Recent activities</h2>
                <button className={s.linkButton} onClick={() => setTab('activities')}>View all</button>
              </div>
              {events.slice(0, 3).map((e) => <EventRow key={e.id} e={e} who={who} />)}
              {!events.length && !detail.isPending && (
                <p className={s.hint}>Nothing logged yet. <button className={s.linkButton} onClick={startNote}>Add the first note</button></p>
              )}
            </section>

            {kind === 'companies' && (
              <section className={s.block}>
                <div className={s.blockHead}>
                  <h2 className={s.blockTitle}>Contacts <span className={s.tabCount}>{detail.data?.contacts.length ?? 0}</span></h2>
                </div>
                {detail.data?.contacts.length ? (
                  <div className={s.miniTableWrap}>
                    <table className={s.miniTable}>
                      <thead><tr><th>Name</th><th>Job title</th><th>Email</th><th>Phone</th></tr></thead>
                      <tbody>
                        {detail.data.contacts.map((c) => (
                          <tr key={c.id}>
                            <td><Link className={s.miniName} to={`/crm/contacts/${c.id}${book}`}><Avatar name={c.name} kind="contacts" />{c.name}</Link></td>
                            <td>{c.title || <span className={s.hint}>—</span>}</td>
                            <td>{c.email ? <a className={s.extLink} href={`mailto:${c.email}`}>{c.email}</a> : <span className={s.hint}>—</span>}</td>
                            <td>{c.phone || <span className={s.hint}>—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className={s.hint}>No contacts are linked to this company yet. Set a contact’s Company property to link it.</p>}
              </section>
            )}

            {kind !== 'deals' && (
              <section className={s.block}>
                <h2 className={s.blockTitle}>Deals <span className={s.tabCount}>{detail.data?.deals.length ?? 0}</span></h2>
                {detail.data?.deals.length ? detail.data.deals.map((d) => (
                  <Link key={d.id} className={s.assocRow} to={`/crm/deals/${d.id}${book}`}>
                    <Avatar name={d.name} kind="deals" /><span>{d.name}</span><strong>{formatMoney(Number(d.value), d.currency)}</strong>
                  </Link>
                )) : <p className={s.hint}>No deals yet.</p>}
              </section>
            )}
          </div>
        ) : (
          <div className={s.overview}>
            <section className={`${s.block} ${s.composer}`}>
              <h2 className={s.blockTitle}>Create note</h2>
              <textarea ref={composer} aria-label="Add a note" placeholder="Log a note, call, meeting or decision…" value={note} onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void addNote(); }} />
              <div className={s.choiceRow} style={{ alignItems: 'center' }}>
                <button className={s.primary} disabled={!note.trim()} onClick={() => void addNote()}>Save note</button>
                <span className={s.hint}>Ctrl+Enter to save</span>
              </div>
              {error && <p className={s.error} style={{ margin: 0 }}>{error}</p>}
            </section>
            <div className={s.segmented} role="group" aria-label="Show">
              {(['all', 'notes', 'changes'] as const).map((f) => (
                <button key={f} className={activityFilter === f ? s.segmentOn : undefined} aria-pressed={activityFilter === f} onClick={() => setActivityFilter(f)}>
                  {f === 'all' ? 'All activity' : f === 'notes' ? 'Notes' : 'Changes'}
                </button>
              ))}
            </div>
            <Timeline events={filtered} who={who} userId={userId} onDelete={deleteNote} />
            {!filtered.length && !detail.isPending && <p className={s.hint}>Nothing here yet.</p>}
          </div>
        )}
      </main>

      {/* ── Right: associations ── */}
      <aside className={s.recordRail}>
        {kind !== 'companies' && (
          <Card title="Company" count={detail.data?.company ? 1 : 0}>
            {detail.data?.company ? (
              <Link className={s.assocCard} to={`/crm/companies/${detail.data.company.id}${book}`}>
                <Avatar name={detail.data.company.name} kind="companies" size="md" />
                <span className={s.assocText}>
                  <strong>{detail.data.company.name}</strong>
                  <span>{[detail.data.company.domain?.replace(/^https?:\/\/(www\.)?/i, ''), detail.data.company.industry].filter(Boolean).join(' · ')}</span>
                </span>
              </Link>
            ) : <p className={s.hint}>Not linked to a company. Set the Company property on the left.</p>}
          </Card>
        )}
        {kind === 'deals' && (
          <Card title="Contact" count={detail.data?.contact ? 1 : 0}>
            {detail.data?.contact ? (
              <Link className={s.assocCard} to={`/crm/contacts/${detail.data.contact.id}${book}`}>
                <Avatar name={detail.data.contact.name} kind="contacts" size="md" />
                <span className={s.assocText}><strong>{detail.data.contact.name}</strong><span>{detail.data.contact.title || detail.data.contact.email || ''}</span></span>
              </Link>
            ) : <p className={s.hint}>No contact on this deal yet.</p>}
          </Card>
        )}
        {kind === 'companies' && (
          <Card title="Contacts" count={detail.data?.contacts.length ?? 0}>
            {detail.data?.contacts.slice(0, 5).map((c) => (
              <Link key={c.id} className={s.assocCard} to={`/crm/contacts/${c.id}${book}`}>
                <Avatar name={c.name} kind="contacts" size="md" />
                <span className={s.assocText}><strong>{c.name}</strong><span>{c.title || c.email || ''}</span></span>
              </Link>
            ))}
            {(detail.data?.contacts.length ?? 0) > 5 && (
              <button className={s.linkButton} onClick={() => setTab('overview')}>View all {detail.data!.contacts.length} contacts</button>
            )}
            {!detail.data?.contacts.length && <p className={s.hint}>No contacts yet.</p>}
          </Card>
        )}
        {kind !== 'deals' && (
          <Card title="Deals" count={detail.data?.deals.length ?? 0} defaultOpen={(detail.data?.deals.length ?? 0) > 0}>
            {detail.data?.deals.map((d) => (
              <Link key={d.id} className={s.assocCard} to={`/crm/deals/${d.id}${book}`}>
                <Avatar name={d.name} kind="deals" size="md" />
                <span className={s.assocText}><strong>{d.name}</strong><span>{formatMoney(Number(d.value), d.currency)}</span></span>
              </Link>
            ))}
            {!detail.data?.deals.length && <p className={s.hint}>No deals yet.</p>}
          </Card>
        )}
        {company?.drive_folder_id && (
          <Card title="Brand files">
            <p className={s.hint}>Logos, fonts and guidelines live in this company’s Drive folder.</p>
            <Link className={s.button} style={{ alignSelf: 'start' }} to={`/drive/folder/${company.drive_folder_id}`}>Open company Drive</Link>
          </Card>
        )}
        <Card title="Attachments & links" count={detail.data?.links.length ?? 0}
          action={<LinkResource ws={ws} userId={userId} kind={kind} id={record.id} onSaved={() => detail.refetch()} />}>
          {detail.data?.links.map((l: { id: string; item_id: string | null; task_id: string | null; channel_id: string | null }) => (
            <Link key={l.id} className={s.linkRow} to={l.item_id ? (company?.drive_folder_id === l.item_id ? `/drive/folder/${l.item_id}` : `/drive/item/${l.item_id}`) : l.task_id ? `/tasks/${l.task_id}` : `/channels/${l.channel_id}`}>
              <span aria-hidden="true">{l.item_id ? '📄' : l.task_id ? '☑' : '#'}</span>
              {l.item_id ? (kind === 'companies' && company?.drive_folder_id === l.item_id ? 'Drive folder' : 'Linked file') : l.task_id ? (company?.brand_task_id === l.task_id ? 'Brand files task' : 'Linked task') : 'Linked conversation'}
            </Link>
          ))}
          {!detail.data?.links.length && <p className={s.hint}>No files, tasks or conversations linked yet.</p>}
        </Card>
      </aside>
    </div>
  );
}

function QuickAction({ icon, label, onClick, href: link, to, external }: { icon: string; label: string; onClick?: () => void; href?: string; to?: string; external?: boolean }) {
  const inner = <><span className={s.actionIcon} aria-hidden="true">{icon}</span><span>{label}</span></>;
  if (to) return <Link className={s.actionButton} to={to}>{inner}</Link>;
  if (link) return <a className={s.actionButton} href={link} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{inner}</a>;
  if (onClick) return <button type="button" className={s.actionButton} onClick={onClick}>{inner}</button>;
  return <span className={`${s.actionButton} ${s.actionOff}`} title={`No ${label.toLowerCase()} details on this record`} aria-disabled="true">{inner}</span>;
}

function EventRow({ e, who }: { e: Event; who: (id: string | null) => string }) {
  return (
    <div className={s.eventRow}>
      <span className={`${s.eventIcon} ${e.note ? s.eventIconNote : ''}`} aria-hidden="true">{e.note ? '✎' : '↻'}</span>
      <div className={s.eventContent}>
        <span className={s.eventTitle}><strong>{e.note ? 'Note' : 'Update'}</strong> by {who(e.who)}<span className={s.eventTime}>{new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span></span>
        <span className={e.note ? s.eventNote : s.hint}>{e.body}</span>
      </div>
    </div>
  );
}

function Timeline({ events, who, userId, onDelete }: { events: Event[]; who: (id: string | null) => string; userId: string; onDelete: (id: string) => void }) {
  const groups: { month: string; items: Event[] }[] = [];
  for (const e of events) {
    const month = new Date(e.at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (groups.at(-1)?.month !== month) groups.push({ month, items: [] });
    groups.at(-1)!.items.push(e);
  }
  return (
    <div className={s.timeline}>
      {groups.map((g) => (
        <section key={g.month}>
          <h3 className={s.monthHead}>{g.month}</h3>
          {g.items.map((e) => (
            <div key={e.id} className={s.timelineItem}>
              <EventRow e={e} who={who} />
              {e.note && e.who === userId && <button className={`${s.ghost} ${s.timelineDelete}`} onClick={() => onDelete(e.id)}>Delete</button>}
            </div>
          ))}
        </section>
      ))}
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
      <button className={s.linkButton} onClick={() => setOpen(true)}>+ Add</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Link a file, task or conversation">
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
