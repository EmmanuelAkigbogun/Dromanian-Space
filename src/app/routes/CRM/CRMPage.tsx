// The CRM, after OpenCRM (MIT, clawnify/OpenCRM): each list is a spreadsheet
// with saved views, filters and footer calculations; deals also show as a
// board; every record has a page with its details, notes and links. Each
// client company can keep its own CRM (client_id), kept apart from ours.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { useAuth } from '@/hooks/useAuth';
import { Dialog } from '@/components/ui/Dialog';
import { platform, result, errorText, workspacePeople } from '@/features/platform/client';
import { RecordTable } from './RecordTable';
import { DealsBoard } from './DealsBoard';
import { RecordView } from './RecordView';
import { ImportDialog } from './ImportDialog';
import { toCsv } from './spreadsheet';
import {
  EMPTY_VIEW, OPERATORS, SINGULAR, STAGE_COLORS, TABLES, applyView, columnsFor, displayValue, filterKind,
  needsValue, patchFor, sameView, savedFromView, viewFromSaved,
  type Column, type Company, type Context, type CrmRecord, type CustomField, type Deal, type Kind,
  type Rule, type SavedView, type Stage, type ViewState,
} from './model';
import s from './CRM.module.css';

const KINDS: Kind[] = ['companies', 'contacts', 'deals'];
const LIMIT = 1000;

export default function CRMPage() {
  const { currentWorkspace, currentRole } = useWorkspaceContext();
  const { userId } = useAuth();
  const { kind } = useParams();
  const [params] = useSearchParams();
  const client = params.get('client');
  const k: Kind = KINDS.includes(kind as Kind) ? (kind as Kind) : 'companies';
  return (
    <CRM
      key={`${currentWorkspace!.id}:${userId}:${k}:${client}`}
      ws={currentWorkspace!.id}
      userId={userId!}
      admin={currentRole === 'owner' || currentRole === 'admin'}
      kind={k}
      client={client}
    />
  );
}

function CRM({ ws, userId, admin, kind, client }: { ws: string; userId: string; admin: boolean; kind: Kind; client: string | null }) {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const base = ['platform', ws, userId, 'crm'];
  const book = client ? `?client=${client}` : '';
  const inBook = <Q extends { eq: (c: string, v: string) => Q; is: (c: string, v: null) => Q }>(q: Q) => (client ? q.eq('client_id', client) : q.is('client_id', null));

  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewState>(EMPTY_VIEW);
  const [activeView, setActiveView] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [board, setBoard] = useState(kind === 'deals');
  const [pipelineId, setPipelineId] = useState('');
  const [dialog, setDialog] = useState<'new' | 'import' | 'client' | 'stages' | 'properties' | 'saveView' | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const clients = useQuery({
    queryKey: [...base, 'clients'],
    queryFn: (): Promise<Company[]> => result(platform.from('crm_companies').select('*').eq('workspace_id', ws).eq('is_client', true).is('client_id', null).order('name')),
  });
  const clientName = client ? clients.data?.find((c) => c.id === client)?.name ?? 'Client' : null;
  const bookName = clientName ? `${clientName}'s CRM` : 'our CRM';

  const ctx = useQuery({
    queryKey: [...base, 'context', client],
    queryFn: async (): Promise<Context> => {
      const [companies, contacts, stages, pipelines, fields, people] = await Promise.all([
        result(inBook(platform.from('crm_companies').select('id,name').eq('workspace_id', ws)).order('name').limit(2000)),
        result(inBook(platform.from('crm_contacts').select('id,name').eq('workspace_id', ws)).order('name').limit(2000)),
        result(platform.from('crm_stages').select('*').eq('workspace_id', ws).order('position')),
        result(platform.from('crm_pipelines').select('*').eq('workspace_id', ws)),
        result(platform.from('crm_custom_fields').select('*').eq('workspace_id', ws).order('position')),
        workspacePeople(ws),
      ]);
      return { companies, contacts, stages, pipelines, fields, people };
    },
  });
  const context = useMemo<Context>(() => ctx.data ?? { companies: [], contacts: [], stages: [], pipelines: [], fields: [], people: [] }, [ctx.data]);
  const columns = useMemo(() => columnsFor(kind, context), [kind, context]);
  const visible = columns.filter((c) => !(view.columns[c.key]?.hidden ?? !c.shown));
  const pipeline = pipelineId || context.pipelines[0]?.id || '';

  const views = useQuery({
    queryKey: [...base, 'views', kind],
    queryFn: (): Promise<SavedView[]> => result(platform.from('crm_views').select('*').eq('workspace_id', ws).eq('entity', kind).order('position').order('created_at')),
  });
  const savedView = views.data?.find((v) => v.id === activeView);
  const dirty = savedView ? !sameView(view, viewFromSaved(savedView)) : !sameView(view, EMPTY_VIEW);

  const rows = useQuery({
    queryKey: [...base, 'rows', kind, client, search, JSON.stringify(savedFromView(view)), ctx.isSuccess],
    enabled: !recordId && ctx.isSuccess,
    queryFn: async (): Promise<CrmRecord[]> => {
      let q = inBook(platform.from(TABLES[kind]).select('*').eq('workspace_id', ws));
      if (search.trim()) q = q.ilike('name', `*${search.trim().replaceAll('*', '').replaceAll(',', ' ')}*`);
      q = applyView(q, view, columns);
      q = q.order(view.sort ?? 'updated_at', { ascending: view.sort ? !view.sortDesc : false }).limit(LIMIT);
      return result(q);
    },
    placeholderData: (prev) => prev,
  });

  const record = useQuery({
    queryKey: [...base, 'one', kind, recordId],
    enabled: !!recordId,
    queryFn: (): Promise<CrmRecord | null> => result(platform.from(TABLES[kind]).select('*').eq('workspace_id', ws).eq('id', recordId!).maybeSingle()),
  });

  const refresh = () => cache.invalidateQueries({ queryKey: base });
  const editable = (r: CrmRecord) => admin || r.owner_id === userId || r.created_by === userId;

  const suggestions = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const c of columns.filter((c) => c.suggest)) {
      out[c.key] = [...new Set((rows.data ?? []).map((r) => displayValue(r, c)).filter(Boolean))].sort().slice(0, 100);
    }
    return out;
  }, [columns, rows.data]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const saveCell = async (r: CrmRecord, column: Column, value: unknown) => {
    const patch = patchFor(r, column, value);
    const apply = (list: CrmRecord[] | undefined) => list?.map((x) => (x.id === r.id ? ({ ...x, ...patch } as CrmRecord) : x));
    cache.setQueriesData<CrmRecord[]>({ queryKey: [...base, 'rows', kind] }, apply);
    cache.setQueryData<CrmRecord | null>([...base, 'one', kind, r.id], (x) => (x ? ({ ...x, ...patch } as CrmRecord) : x));
    try {
      setError('');
      await result(platform.from(TABLES[kind]).update(patch).eq('id', r.id).eq('workspace_id', ws));
      if (column.key === 'company_id' || column.key === 'name') void cache.invalidateQueries({ queryKey: [...base, 'context'] });
    } catch (e) {
      setError(errorText(e));
      await refresh();
    }
  };

  const exportCsv = () => {
    const header = visible.map((c) => c.label);
    const body = (rows.data ?? []).map((r) => visible.map((c) => displayValue(r, c)));
    const blob = new Blob([`﻿${toCsv(header, body)}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${clientName ?? 'crm'}-${kind}-${new Date().toISOString().slice(0, 10)}.csv`.replace(/[^\w.-]+/g, '-');
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const deleteSelected = () => {
    if (!window.confirm(`Delete ${selected.size} ${selected.size === 1 ? SINGULAR[kind] : kind}? Linked contacts and deals stay, unlinked; Drive folders are kept.`)) return;
    void act(async () => {
      await result(platform.from(TABLES[kind]).delete().eq('workspace_id', ws).in('id', [...selected]));
      setSelected(new Set());
    });
  };

  const selectedRecord = recordId ? record.data : null;
  const selectedCompany = kind === 'companies' ? (selectedRecord as Company | null) : null;
  const anyError = error || rows.error || ctx.error || record.error || clients.error || views.error;

  return (
    <div className={s.page}>
      <div className={s.top}>
        <div className={s.titleRow}>
          <h1 className={s.title}>{selectedRecord?.name ?? (clientName ? `${clientName}'s CRM` : 'CRM')}</h1>
          <div className={s.books} role="navigation" aria-label="CRMs">
            <Link className={`${s.chip} ${!client ? s.chipActive : ''}`} to={`/crm/${kind}`}>Our CRM</Link>
            {clients.data?.map((c) => (
              <Link key={c.id} className={`${s.chip} ${client === c.id ? s.chipActive : ''}`} to={`/crm/${kind}?client=${c.id}`}>{c.name}</Link>
            ))}
            <button className={s.chip} onClick={() => setDialog('client')}>+ Client CRM</button>
          </div>
        </div>
        <nav className={s.kinds} aria-label="Records">
          {KINDS.map((x) => (
            <Link key={x} className={`${s.kind} ${x === kind ? s.kindActive : ''}`} to={`/crm/${x}${book}`}>
              {x[0].toUpperCase() + x.slice(1)}
              {x === kind && !recordId && rows.data && <span className={s.count}>{rows.data.length}{rows.data.length === LIMIT ? '+' : ''}</span>}
            </Link>
          ))}
        </nav>
      </div>

      {anyError && <p role="alert" className={s.error} style={{ marginTop: 12 }}>{error || errorText(anyError)}</p>}

      {recordId ? (
        <>
          <div className={s.toolbar}>
            <Link className={s.button} to={`/crm/${kind}${book}`}>← Back to {kind}</Link>
            {selectedCompany && !selectedCompany.client_id && (selectedCompany.is_client
              ? <Link className={s.button} to={`/crm/companies?client=${selectedCompany.id}`}>Open {selectedCompany.name}'s CRM</Link>
              : editable(selectedCompany) && (
                <button className={s.button} disabled={busy} onClick={() => void act(async () => {
                  await result(platform.from('crm_companies').update({ is_client: true }).eq('id', selectedCompany.id).eq('workspace_id', ws));
                  navigate(`/crm/companies?client=${selectedCompany.id}`);
                })}>Give it its own CRM</button>
              ))}
            <Link className={s.button} to={`/agents?crm=${recordId}&crm_kind=${kind}`}>Ask Sales Assistant</Link>
            <span className={s.spacer} />
            {admin && selectedRecord && (
              <button className={`${s.button} ${s.danger}`} disabled={busy} onClick={() => {
                if (!window.confirm(`Delete ${selectedRecord.name}? Its contacts and deals stay, unlinked; its Drive folder is kept.`)) return;
                void act(async () => {
                  await result(platform.from(TABLES[kind]).delete().eq('id', selectedRecord.id).eq('workspace_id', ws));
                  navigate(`/crm/${kind}${book}`);
                });
              }}>Delete</button>
            )}
          </div>
          {selectedRecord ? (
            <RecordView ws={ws} userId={userId} kind={kind} record={selectedRecord} columns={columns} people={context.people}
              editable={editable(selectedRecord)} suggestions={suggestions} onSave={saveCell} book={book} />
          ) : (
            <div className={s.empty}>{record.isPending ? 'Loading…' : 'This record is no longer available.'}</div>
          )}
        </>
      ) : (
        <>
          <div className={s.views} style={{ padding: '12px 20px 0' }}>
            <button className={`${s.chip} ${!activeView ? s.chipActive : ''}`} onClick={() => { setActiveView(null); setView(EMPTY_VIEW); }}>All {kind}</button>
            {views.data?.map((v) => (
              <button key={v.id} className={`${s.chip} ${activeView === v.id ? s.chipActive : ''}`} onClick={() => { setActiveView(v.id); setView(viewFromSaved(v)); }}>{v.name}</button>
            ))}
            {dirty && savedView && (
              <button className={s.ghost} disabled={busy} onClick={() => void act(() => result(platform.from('crm_views').update(savedFromView(view)).eq('id', savedView.id)))}>Update “{savedView.name}”</button>
            )}
            {dirty && <button className={s.ghost} onClick={() => setDialog('saveView')}>Save as view</button>}
            {savedView && (admin || savedView.created_by === userId) && (
              <button className={s.ghost} onClick={() => {
                if (!window.confirm(`Delete the view “${savedView.name}”?`)) return;
                void act(async () => { await result(platform.from('crm_views').delete().eq('id', savedView.id)); setActiveView(null); setView(EMPTY_VIEW); });
              }}>Delete view</button>
            )}
          </div>

          <div className={s.toolbar}>
            <input className={s.search} type="search" aria-label={`Search ${kind}`} placeholder={`Search ${kind}…`} value={search} onChange={(e) => setSearch(e.target.value)} />
            <button className={s.button} onClick={() => setView({ ...view, rules: [...view.rules, { field: (visible[1] ?? columns[0]).key, op: OPERATORS[filterKind((visible[1] ?? columns[0]).type)][0].op }] })}>+ Filter</button>
            {kind === 'companies' && (
              <button className={s.button} onClick={() => setView({ ...view, rules: [...view.rules, { field: 'customer_since', op: 'not_empty' }] })}>Customers</button>
            )}
            {kind === 'deals' && <button className={s.button} onClick={() => setBoard(!board)}>{board ? 'Table' : 'Board'}</button>}
            <div className={s.menuWrap}>
              <button className={s.button} onClick={() => setColumnsOpen(!columnsOpen)} aria-expanded={columnsOpen}>Columns</button>
              {columnsOpen && (
                <div className={s.menu} onMouseLeave={() => setColumnsOpen(false)}>
                  {columns.slice(1).map((c) => {
                    const hidden = view.columns[c.key]?.hidden ?? !c.shown;
                    return (
                      <label key={c.key}>
                        <input type="checkbox" checked={!hidden} onChange={() => setView({ ...view, columns: { ...view.columns, [c.key]: { ...view.columns[c.key], hidden: !hidden } } })} />
                        {c.label}
                      </label>
                    );
                  })}
                  {admin && <button className={s.ghost} onClick={() => { setColumnsOpen(false); setDialog('properties'); }}>Manage properties…</button>}
                </div>
              )}
            </div>
            <span className={s.spacer} />
            {kind !== 'deals' && <button className={s.button} onClick={() => setDialog('import')}>Import</button>}
            <button className={s.button} onClick={exportCsv} disabled={!rows.data?.length}>Export</button>
            {kind === 'deals' && admin && <button className={s.button} onClick={() => setDialog('stages')}>Stages</button>}
            <button className={s.primary} onClick={() => setDialog('new')}>New {SINGULAR[kind]}</button>
          </div>

          {view.rules.length > 0 && <FilterBar view={view} columns={columns} onView={setView} />}
          {clientName && <p className={s.hint} style={{ padding: '0 20px 8px' }}>Records here stay separate from our CRM. Companies added here get no Drive folder.</p>}
          {selected.size > 0 && (
            <div className={s.bulk}>
              {selected.size} selected
              {admin && <button className={`${s.button} ${s.danger}`} disabled={busy} onClick={deleteSelected}>Delete</button>}
              <button className={s.ghost} onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          )}

          {rows.isPending ? (
            <div className={s.empty}>Loading…</div>
          ) : kind === 'deals' && board ? (
            <DealsBoard
              deals={(rows.data ?? []) as Deal[]}
              stages={context.stages}
              pipelines={context.pipelines}
              pipelineId={pipeline}
              onPipeline={setPipelineId}
              companyName={(id) => context.companies.find((c) => c.id === id)?.name ?? ''}
              canEdit={editable}
              onMove={(d, stageId) => saveCell(d, columns.find((c) => c.key === 'stage_id')!, stageId)}
              book={book}
            />
          ) : !rows.data?.length && !search && !view.rules.length ? (
            <div className={s.empty}>
              <p>No {kind} in {bookName} yet.</p>
              <div className={s.choiceRow} style={{ justifyContent: 'center' }}>
                <button className={s.primary} onClick={() => setDialog('new')}>New {SINGULAR[kind]}</button>
                {kind !== 'deals' && <button className={s.button} onClick={() => setDialog('import')}>Import from a file or Drive</button>}
              </div>
            </div>
          ) : (
            <RecordTable kind={kind} records={rows.data ?? []} columns={visible} view={view} onView={setView} canEdit={editable}
              onSave={saveCell} selected={selected} onSelect={setSelected} book={book} suggestions={suggestions} />
          )}
        </>
      )}

      {dialog === 'new' && ctx.data && (
        <NewRecord ws={ws} userId={userId} kind={kind} client={client} ctx={ctx.data} pipelineId={pipeline}
          onClose={() => setDialog(null)} onSaved={async (id) => { setDialog(null); await refresh(); navigate(`/crm/${kind}/${id}${book}`); }} />
      )}
      {dialog === 'import' && kind !== 'deals' && (
        <ImportDialog ws={ws} userId={userId} admin={admin} kind={kind} client={client} bookName={bookName} fields={context.fields}
          onClose={() => setDialog(null)} onDone={async () => { await refresh(); }} />
      )}
      {dialog === 'client' && (
        <AddClient ws={ws} userId={userId} onClose={() => setDialog(null)} onSaved={async (id) => { setDialog(null); await refresh(); navigate(`/crm/companies?client=${id}`); }} />
      )}
      {dialog === 'stages' && <StagesDialog ws={ws} stages={context.stages} pipelines={context.pipelines} pipelineId={pipeline} onClose={() => setDialog(null)} onChanged={refresh} />}
      {dialog === 'properties' && <PropertiesDialog ws={ws} userId={userId} kind={kind} fields={context.fields} onClose={() => setDialog(null)} onChanged={refresh} />}
      {dialog === 'saveView' && (
        <NameDialog title="Save view" label="View name" onClose={() => setDialog(null)} onSave={async (name) => {
          const row = await result(platform.from('crm_views').insert({ workspace_id: ws, entity: kind, name, created_by: userId, position: views.data?.length ?? 0, ...savedFromView(view) }).select().single());
          setActiveView(row.id);
          setDialog(null);
          await refresh();
        }} />
      )}
    </div>
  );
}

function FilterBar({ view, columns, onView }: { view: ViewState; columns: Column[]; onView: (v: ViewState) => void }) {
  const setRule = (i: number, rule: Rule) => onView({ ...view, rules: view.rules.map((r, j) => (j === i ? rule : r)) });
  return (
    <div className={s.filters}>
      {view.rules.map((rule, i) => {
        const column = columns.find((c) => c.key === rule.field) ?? columns[0];
        const fk = filterKind(column.type);
        const value = Array.isArray(rule.value) ? rule.value[0] ?? '' : rule.value ?? '';
        return (
          <span key={i} className={s.rule}>
            <select aria-label="Field" value={column.key} onChange={(e) => {
              const c = columns.find((x) => x.key === e.target.value)!;
              setRule(i, { field: c.key, op: OPERATORS[filterKind(c.type)][0].op });
            }}>
              {columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <select aria-label="Condition" value={rule.op} onChange={(e) => setRule(i, { ...rule, op: e.target.value })}>
              {OPERATORS[fk].map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
            {needsValue(rule.op) && (fk === 'choice' && column.options ? (
              <select aria-label="Value" value={value} onChange={(e) => setRule(i, { ...rule, value: e.target.value ? [e.target.value] : [] })}>
                <option value="">Choose…</option>
                {column.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input aria-label="Value" type={fk === 'date' && !rule.op.endsWith('_days') ? 'date' : fk === 'number' || rule.op.endsWith('_days') ? 'number' : 'text'}
                value={value} onChange={(e) => setRule(i, { ...rule, value: fk === 'choice' ? [e.target.value] : e.target.value })} />
            ))}
            <button className={s.ruleRemove} aria-label="Remove filter" onClick={() => onView({ ...view, rules: view.rules.filter((_, j) => j !== i) })}>×</button>
          </span>
        );
      })}
      {view.rules.length > 1 && (
        <select className={s.rule} aria-label="Match" value={view.match} onChange={(e) => onView({ ...view, match: e.target.value as 'all' | 'any' })}>
          <option value="all">Match all filters</option>
          <option value="any">Match any filter</option>
        </select>
      )}
      <button className={s.ghost} onClick={() => onView({ ...view, rules: [] })}>Clear filters</button>
    </div>
  );
}

function NewRecord({ ws, userId, kind, client, ctx, pipelineId, onClose, onSaved }: {
  ws: string; userId: string; kind: Kind; client: string | null; ctx: Context; pipelineId: string;
  onClose: () => void; onSaved: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [pipeline, setPipeline] = useState(pipelineId);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const stages = ctx.stages.filter((st) => st.pipeline_id === pipeline);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const common = { workspace_id: ws, name: name.trim(), owner_id: userId, created_by: userId, client_id: client };
      const row = kind === 'deals' ? { ...common, pipeline_id: pipeline, stage_id: stages[0]?.id, value: 0, currency: 'EUR' } : common;
      const created = await result(platform.from(TABLES[kind]).insert(row).select('id').single());
      await onSaved(created.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`New ${SINGULAR[kind]}`} size="sm">
      <form className={s.form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>Name<input className={s.input} autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></label>
        {kind === 'deals' && (
          <label>Pipeline
            <select className={s.input} value={pipeline} onChange={(e) => setPipeline(e.target.value)} required>
              {ctx.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        {kind === 'deals' && !ctx.pipelines.length && <p className={s.hint}>An administrator needs to create a pipeline first (Stages).</p>}
        <p className={s.hint}>Fill in the rest on the record’s page.</p>
        {error && <p className={s.error}>{error}</p>}
        <button className={s.primary} disabled={busy || !name.trim() || (kind === 'deals' && !stages.length)}>Create</button>
      </form>
    </Dialog>
  );
}

function AddClient({ ws, userId, onClose, onSaved }: { ws: string; userId: string; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [pick, setPick] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ours = useQuery({
    queryKey: ['platform', ws, userId, 'crm', 'our-companies'],
    queryFn: (): Promise<{ id: string; name: string }[]> => result(platform.from('crm_companies').select('id,name').eq('workspace_id', ws).is('client_id', null).eq('is_client', false).order('name').limit(1000)),
  });
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = pick
        ? await result(platform.from('crm_companies').update({ is_client: true }).eq('id', pick).eq('workspace_id', ws).select('id').single())
        : await result(platform.from('crm_companies').insert({ workspace_id: ws, name: name.trim(), owner_id: userId, created_by: userId, is_client: true }).select('id').single());
      await onSaved(r.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title="New client CRM" size="sm">
      <form className={s.form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <p className={s.hint}>A client CRM keeps that client's own companies, contacts and deals apart from ours.</p>
        <label>Client
          <select className={s.input} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">New company…</option>
            {ours.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {!pick && <label>Company name<input className={s.input} value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></label>}
        {(error || ours.error) && <p className={s.error}>{error || errorText(ours.error)}</p>}
        <button className={s.primary} disabled={busy || (!pick && !name.trim())}>Create client CRM</button>
      </form>
    </Dialog>
  );
}

function NameDialog({ title, label, onClose, onSave }: { title: string; label: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  return (
    <Dialog open onClose={onClose} title={title} size="sm">
      <form className={s.form} onSubmit={(e) => { e.preventDefault(); onSave(name.trim()).catch((err) => setError(errorText(err))); }}>
        <label>{label}<input className={s.input} autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
        {error && <p className={s.error}>{error}</p>}
        <button className={s.primary} disabled={!name.trim()}>Save</button>
      </form>
    </Dialog>
  );
}

function StagesDialog({ ws, stages, pipelines, pipelineId, onClose, onChanged }: {
  ws: string; stages: Stage[]; pipelines: { id: string; name: string }[]; pipelineId: string; onClose: () => void; onChanged: () => Promise<unknown>;
}) {
  const [pipeline, setPipeline] = useState(pipelineId);
  const [newPipeline, setNewPipeline] = useState('');
  const [newStage, setNewStage] = useState('');
  const [error, setError] = useState('');
  const list = stages.filter((st) => st.pipeline_id === pipeline).sort((a, b) => a.position - b.position);
  const run = (fn: () => Promise<unknown>) => fn().then(onChanged).catch((e) => setError(errorText(e)));
  const save = (st: Stage, patch: Partial<Stage>) => {
    const next = { ...st, ...patch };
    if (patch.is_won) next.is_lost = false;
    if (patch.is_lost) next.is_won = false;
    return run(() => result(platform.rpc('crm_save_stage', { p_workspace_id: ws, p_pipeline_id: pipeline, p_stage_id: st.id, p_name: next.name, p_color: next.color, p_is_won: next.is_won, p_is_lost: next.is_lost })));
  };
  const move = (i: number, by: number) => {
    const ids = list.map((st) => st.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    return run(() => result(platform.rpc('crm_reorder_stages', { p_workspace_id: ws, p_pipeline_id: pipeline, p_stage_ids: ids })));
  };
  return (
    <Dialog open onClose={onClose} title="Pipeline stages" size="lg">
      <div className={s.form}>
        {pipelines.length > 0 && (
          <select className={s.input} value={pipeline} onChange={(e) => setPipeline(e.target.value)} aria-label="Pipeline">
            {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {list.map((st, i) => (
          <div key={st.id} className={s.stageRow}>
            <input className={s.input} defaultValue={st.name} aria-label="Stage name" onBlur={(e) => { if (e.target.value.trim() && e.target.value !== st.name) void save(st, { name: e.target.value.trim() }); }} />
            <select className={s.input} value={st.color} aria-label="Colour" onChange={(e) => void save(st, { color: e.target.value })}>
              {STAGE_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className={s.input} value={st.is_won ? 'won' : st.is_lost ? 'lost' : 'open'} aria-label="Meaning"
              onChange={(e) => void save(st, { is_won: e.target.value === 'won', is_lost: e.target.value === 'lost' })}>
              <option value="open">Open</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
            </select>
            <span className={s.choiceRow}>
              <button className={s.ghost} disabled={i === 0} onClick={() => void move(i, -1)} aria-label="Move up">↑</button>
              <button className={s.ghost} disabled={i === list.length - 1} onClick={() => void move(i, 1)} aria-label="Move down">↓</button>
            </span>
            <button className={`${s.ghost} ${s.danger}`} aria-label={`Delete ${st.name}`} onClick={() => {
              const target = list.find((x) => x.id !== st.id);
              if (!window.confirm(`Delete “${st.name}”? Its deals move to “${target?.name}”.`)) return;
              void run(() => result(platform.rpc('crm_delete_stage', { p_workspace_id: ws, p_stage_id: st.id, p_move_to: target?.id ?? null })));
            }}>Delete</button>
          </div>
        ))}
        {pipeline && (
          <form className={s.choiceRow} onSubmit={(e) => {
            e.preventDefault();
            if (!newStage.trim()) return;
            void run(() => result(platform.rpc('crm_save_stage', { p_workspace_id: ws, p_pipeline_id: pipeline, p_stage_id: null, p_name: newStage.trim(), p_color: 'sky' }))).then(() => setNewStage(''));
          }}>
            <input className={s.input} placeholder="New stage" value={newStage} onChange={(e) => setNewStage(e.target.value)} />
            <button className={s.button}>Add stage</button>
          </form>
        )}
        <form className={s.choiceRow} onSubmit={(e) => {
          e.preventDefault();
          if (!newPipeline.trim()) return;
          result(platform.rpc('crm_create_pipeline', { p_workspace_id: ws, p_name: newPipeline.trim() }))
            .then(async (id: string) => { setNewPipeline(''); await onChanged(); setPipeline(id); })
            .catch((err) => setError(errorText(err)));
        }}>
          <input className={s.input} placeholder="New pipeline name" value={newPipeline} onChange={(e) => setNewPipeline(e.target.value)} />
          <button className={s.button}>Create pipeline</button>
        </form>
        {error && <p className={s.error}>{error}</p>}
      </div>
    </Dialog>
  );
}

function PropertiesDialog({ ws, userId, kind, fields, onClose, onChanged }: {
  ws: string; userId: string; kind: Kind; fields: CustomField[]; onClose: () => void; onChanged: () => Promise<unknown>;
}) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState('text');
  const [choices, setChoices] = useState('');
  const [error, setError] = useState('');
  const mine = fields.filter((f) => f.entity === kind);
  const add = async () => {
    setError('');
    try {
      const key = label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40) || 'field';
      await result(platform.from('crm_custom_fields').insert({
        workspace_id: ws, entity: kind, key, label: label.trim(), field_type: type, created_by: userId, position: mine.length,
        options: type === 'select' ? { choices: choices.split(',').map((c) => c.trim()).filter(Boolean) } : {},
      }));
      setLabel('');
      setChoices('');
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Custom properties for ${kind}`} size="md">
      <div className={s.form}>
        {mine.map((f) => (
          <div key={f.id} className={s.choiceRow} style={{ alignItems: 'center' }}>
            <strong style={{ flex: 1 }}>{f.label}</strong>
            <span className={s.hint}>{f.field_type}</span>
            <button className={`${s.ghost} ${s.danger}`} onClick={() => {
              if (!window.confirm(`Remove the property “${f.label}”? Values stay stored but are no longer shown.`)) return;
              result(platform.from('crm_custom_fields').delete().eq('id', f.id)).then(onChanged).catch((e) => setError(errorText(e)));
            }}>Remove</button>
          </div>
        ))}
        {!mine.length && <p className={s.hint}>No custom properties yet.</p>}
        <form className={s.form} onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <label>Name<input className={s.input} value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={80} /></label>
          <label>Type
            <select className={s.input} value={type} onChange={(e) => setType(e.target.value)}>
              {['text', 'long_text', 'number', 'checkbox', 'date', 'select', 'url', 'email', 'phone', 'tags'].map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
            </select>
          </label>
          {type === 'select' && <label>Choices (comma separated)<input className={s.input} value={choices} onChange={(e) => setChoices(e.target.value)} /></label>}
          <button className={s.primary} disabled={!label.trim()}>Add property</button>
        </form>
        {error && <p className={s.error}>{error}</p>}
      </div>
    </Dialog>
  );
}
