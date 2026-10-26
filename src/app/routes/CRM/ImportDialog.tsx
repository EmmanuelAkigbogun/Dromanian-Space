import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from '@/components/ui/Dialog';
import { platform, result, errorText } from '@/features/platform/client';
import { readSpreadsheet, type Sheet } from './spreadsheet';
import {
  IMPORT_FIELDS, NEW_TYPE_LABELS, buildRows, choicesFrom, guessMapping, keyFor,
  type NewType, type Target,
} from './importMapping';
import type { CustomField } from './model';
import s from './CRM.module.css';

interface Props {
  ws: string;
  userId: string;
  admin: boolean;
  kind: 'companies' | 'contacts';
  client: string | null;
  bookName: string;
  fields: CustomField[];
  onClose: () => void;
  onDone: () => Promise<void>;
}

interface Outcome {
  created: number;
  skipped: number;
  companies_created: number;
  errors: { row: number; error: string }[];
}

const encodeTarget = (t: Target) => (t.kind === 'field' || t.kind === 'custom' ? `${t.kind}:${t.key}` : t.kind === 'new' ? 'new' : t.kind);

/** Import companies or contacts from a CSV or Excel file, uploaded or picked from Drive. */
export function ImportDialog({ ws, userId, admin, kind, client, bookName, fields, onClose, onDone }: Props) {
  const [source, setSource] = useState<'upload' | 'drive'>('drive');
  const [fileName, setFileName] = useState('');
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<Target[]>([]);
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const sheet = sheets[sheetIndex];

  const driveFiles = useQuery({
    queryKey: ['platform', ws, userId, 'crm-import-files'],
    enabled: source === 'drive',
    queryFn: async () => {
      const rows: { id: string; name: string; current_version_id: string | null; updated_at: string }[] = await result(
        platform.from('drive_items').select('id,name,current_version_id,updated_at')
          .eq('workspace_id', ws).eq('kind', 'file').is('trashed_at', null)
          .or('name.ilike.*.xlsx,name.ilike.*.csv')
          .order('updated_at', { ascending: false }).limit(200),
      );
      return rows.filter((r) => r.current_version_id);
    },
  });

  const load = async (blob: Blob, name: string) => {
    setError('');
    setBusy(true);
    try {
      const found = (await readSpreadsheet(blob, name)).filter((x) => x.rows.length);
      if (!found.length) throw new Error('No rows found in this file.');
      const best = found.reduce((a, b, i) => (b.rows.length > found[a].rows.length ? i : a), 0);
      setFileName(name);
      setSheets(found);
      pickSheet(found, best);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const pickSheet = (list: Sheet[], i: number) => {
    setSheetIndex(i);
    setMapping(guessMapping(kind, list[i].header, list[i].rows, fields, admin));
  };

  const fromDrive = async (item: { id: string; name: string; current_version_id: string | null }) => {
    setBusy(true);
    setError('');
    try {
      const version = await result(platform.from('drive_versions').select('storage_bucket,storage_path').eq('id', item.current_version_id!).single());
      const signed = await result(platform.storage.from(version.storage_bucket).createSignedUrl(version.storage_path, 60));
      const response = await fetch(signed.signedUrl);
      if (!response.ok) throw new Error('The file could not be downloaded.');
      await load(await response.blob(), item.name);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const options = useMemo(() => [
    ...IMPORT_FIELDS[kind].map((f) => ({ value: `field:${f.key}`, label: f.label })),
    ...fields.filter((f) => f.entity === kind).map((f) => ({ value: `custom:${f.key}`, label: `${f.label} (property)` })),
  ], [kind, fields]);

  const setTarget = (i: number, value: string) => {
    const next = [...mapping];
    if (value === 'new') next[i] = { kind: 'new', label: sheet.header[i], type: 'text' };
    else if (value === 'notes' || value === 'skip') next[i] = { kind: value };
    else {
      const [k, key] = value.split(':');
      next[i] = { kind: k as 'field' | 'custom', key };
    }
    setMapping(next);
  };

  const hasName = mapping.some((t) => t.kind === 'field' && (t.key === 'name' || t.key === 'first_name' || t.key === 'last_name'));

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      // New properties first, so values have somewhere to go.
      const created: CustomField[] = [];
      for (const [i, t] of mapping.entries()) {
        if (t.kind !== 'new') continue;
        const key = keyFor(t.label);
        if (fields.some((f) => f.entity === kind && f.key === key) || created.some((f) => f.key === key)) continue;
        const row = await result(platform.from('crm_custom_fields').insert({
          workspace_id: ws, entity: kind, key, label: t.label.slice(0, 80), field_type: t.type,
          options: t.type === 'select' ? { choices: choicesFrom(sheet.rows, i) } : {},
          position: fields.length + created.length, created_by: userId,
        }).select().single());
        created.push(row);
      }
      const rows = buildRows(kind, sheet.header, sheet.rows, mapping, [...fields, ...created]);
      const total: Outcome = { created: 0, skipped: 0, companies_created: 0, errors: [] };
      for (let i = 0; i < rows.length; i += 500) {
        const part: Outcome = await result(platform.rpc('crm_import', {
          p_workspace_id: ws, p_client_id: client, p_kind: kind, p_rows: rows.slice(i, i + 500), p_setup: setup,
        }));
        total.created += part.created;
        total.skipped += part.skipped;
        total.companies_created += part.companies_created;
        total.errors.push(...part.errors.map((e) => ({ ...e, row: e.row + i })));
      }
      setOutcome(total);
      await onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Import ${kind} into ${bookName}`} size="xl">
      <div className={s.form}>
        {outcome ? (
          <>
            <p>
              Imported <strong>{outcome.created}</strong> {kind}
              {outcome.companies_created > 0 && ` and created ${outcome.companies_created} companies`}. Skipped {outcome.skipped} (duplicates or rows without a name).
            </p>
            {outcome.errors.length > 0 && (
              <div className={s.error}>
                {outcome.errors.slice(0, 5).map((e) => <div key={e.row}>Row {e.row}: {e.error}</div>)}
              </div>
            )}
            <button className={s.primary} onClick={onClose}>Done</button>
          </>
        ) : !sheet ? (
          <>
            <div className={s.choiceRow}>
              <button className={`${s.chip} ${source === 'drive' ? s.chipActive : ''}`} onClick={() => setSource('drive')}>From Drive</button>
              <button className={`${s.chip} ${source === 'upload' ? s.chipActive : ''}`} onClick={() => setSource('upload')}>Upload a file</button>
            </div>
            {source === 'upload' ? (
              <label>
                CSV or Excel (.xlsx) file
                <input className={s.input} type="file" accept=".csv,.xlsx,.tsv,.txt" disabled={busy}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f, f.name); }} />
              </label>
            ) : (
              <div className={s.fileList}>
                {driveFiles.isPending && <p className={s.hint} style={{ padding: 12 }}>Loading Drive files…</p>}
                {driveFiles.data?.length === 0 && <p className={s.hint} style={{ padding: 12 }}>No CSV or Excel files in Drive yet.</p>}
                {driveFiles.data?.map((f) => (
                  <button key={f.id} disabled={busy} onClick={() => void fromDrive(f)}>
                    {f.name} <span className={s.hint}>· {new Date(f.updated_at).toLocaleDateString()}</span>
                  </button>
                ))}
              </div>
            )}
            {busy && <p className={s.hint}>Reading the file…</p>}
          </>
        ) : (
          <>
            <div className={s.choiceRow} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>{fileName}</strong>
              <span className={s.hint}>{sheet.rows.length} rows</span>
              {sheets.length > 1 && (
                <select className={s.input} style={{ width: 'auto' }} value={sheetIndex} onChange={(e) => pickSheet(sheets, Number(e.target.value))} aria-label="Sheet">
                  {sheets.map((x, i) => <option key={x.name} value={i}>{x.name} ({x.rows.length} rows)</option>)}
                </select>
              )}
              <button className={s.ghost} onClick={() => setSheets([])}>Choose another file</button>
            </div>
            <div className={s.mapping}>
              <span className={s.mapHead}>Column in the file</span>
              <span className={s.mapHead}>Goes to</span>
              <span className={s.mapHead}>Example</span>
              {sheet.header.map((h, i) => {
                const t = mapping[i] ?? { kind: 'skip' };
                return (
                  <FragmentRow key={`${h}-${i}`}>
                    <span>{h}</span>
                    <span className={s.choiceRow}>
                      <select className={s.input} value={encodeTarget(t)} onChange={(e) => setTarget(i, e.target.value)} aria-label={`Map ${h}`}>
                        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        {admin && <option value="new">New property…</option>}
                        <option value="notes">Add to notes</option>
                        <option value="skip">Don’t import</option>
                      </select>
                      {t.kind === 'new' && (
                        <select className={s.input} style={{ width: 120 }} value={t.type} aria-label={`Type for ${h}`}
                          onChange={(e) => { const next = [...mapping]; next[i] = { ...t, type: e.target.value as NewType }; setMapping(next); }}>
                          {Object.entries(NEW_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      )}
                    </span>
                    <span className={s.sample}>{sheet.rows.find((r) => r[i])?.[i] ?? ''}</span>
                  </FragmentRow>
                );
              })}
            </div>
            {kind === 'companies' && !client && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={setup} onChange={(e) => setSetup(e.target.checked)} />
                Also create a Drive folder and a brand-files task for each company
              </label>
            )}
            {!hasName && <p className={s.hint}>Map a column to the name to import.</p>}
            <button className={s.primary} disabled={busy || !hasName} onClick={() => void run()}>
              {busy ? 'Importing…' : `Import ${sheet.rows.length} ${kind}`}
            </button>
          </>
        )}
        {error && <p className={s.error} role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

const FragmentRow = ({ children }: { children: React.ReactNode }) => <>{children}</>;
