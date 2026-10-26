// Maps a spreadsheet's columns onto CRM fields for import: built-in fields
// by their usual header names, existing custom properties by label, and the
// rest as new custom properties whose type is guessed from the values (links,
// emails, phones, dates, numbers, yes/no, or a dropdown for a few repeated
// values). Row numbers are skipped; sources and comments go to notes.
import type { CustomField, Kind } from './model';

export type Target =
  | { kind: 'field'; key: string }
  | { kind: 'custom'; key: string }
  | { kind: 'new'; label: string; type: NewType }
  | { kind: 'notes' }
  | { kind: 'skip' };

export type NewType = 'text' | 'long_text' | 'number' | 'checkbox' | 'date' | 'select' | 'url' | 'email' | 'phone';

export const NEW_TYPE_LABELS: Record<NewType, string> = {
  text: 'Text', long_text: 'Long text', number: 'Number', checkbox: 'Yes / no', date: 'Date',
  select: 'Dropdown', url: 'Link', email: 'Email', phone: 'Phone',
};

export const IMPORT_FIELDS: Record<'companies' | 'contacts', { key: string; label: string; names: string[] }[]> = {
  companies: [
    { key: 'name', label: 'Company name', names: ['name', 'company', 'company name', 'organisation', 'organization', 'account', 'denumire', 'firma'] },
    { key: 'domain', label: 'Domain / website', names: ['domain', 'website', 'web', 'site', 'url', 'web site', 'homepage'] },
    { key: 'industry', label: 'Industry', names: ['industry', 'sector', 'vertical', 'domeniu'] },
    { key: 'email', label: 'Email', names: ['email', 'e-mail', 'mail', 'email address'] },
    { key: 'phone', label: 'Phone', names: ['phone', 'phone number', 'telephone', 'tel', 'telefon', 'mobile'] },
    { key: 'has_linkedin', label: 'Has LinkedIn?', names: ['has linkedin', 'linkedin yes/no', 'on linkedin'] },
    { key: 'linkedin_url', label: 'LinkedIn URL', names: ['linkedin url', 'linkedin', 'linkedin page', 'linkedin profile'] },
    { key: 'listed_location', label: 'Listed location', names: ['listed location', 'location', 'city', 'address', 'adresa'] },
    { key: 'prospect_type', label: 'Prospect type', names: ['prospect type', 'type', 'lead type'] },
    { key: 'contact_status', label: 'Contact status', names: ['contact status', 'status'] },
    { key: 'contact_sources', label: 'Contact source URL(s)', names: ['contact source urls', 'contact source url', 'contact sources', 'contact source', 'source', 'sources'] },
    { key: 'location_source', label: 'Location / LinkedIn source', names: ['location / linkedin source', 'location source', 'linkedin source'] },
    { key: 'notes', label: 'Notes', names: ['notes', 'note', 'comments', 'description'] },
  ],
  contacts: [
    { key: 'name', label: 'Name', names: ['name', 'full name', 'contact', 'contact name', 'person', 'nume'] },
    { key: 'first_name', label: 'First name', names: ['first name', 'firstname', 'given name', 'prenume'] },
    { key: 'last_name', label: 'Last name', names: ['last name', 'lastname', 'surname', 'family name'] },
    { key: 'email', label: 'Email', names: ['email', 'e-mail', 'mail', 'email address'] },
    { key: 'phone', label: 'Phone', names: ['phone', 'phone number', 'telephone', 'tel', 'mobile', 'telefon'] },
    { key: 'title', label: 'Job title', names: ['title', 'job title', 'position', 'role', 'functie'] },
    { key: 'company', label: 'Company (matched by name)', names: ['company', 'company name', 'organisation', 'organization', 'account', 'firma'] },
    { key: 'lifecycle_stage', label: 'Lifecycle stage', names: ['lifecycle', 'lifecycle stage', 'status', 'stage'] },
    { key: 'tags', label: 'Tags (comma separated)', names: ['tags', 'labels', 'tag'] },
    { key: 'notes', label: 'Notes', names: ['notes', 'note', 'comments', 'description'] },
  ],
};

const norm = (s: string) => s.toLowerCase().replace(/[?:*()]/g, '').replace(/\s+/g, ' ').trim();
export const keyFor = (label: string) =>
  norm(label).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40) || 'field';

const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const YES_NO = new Set(['yes', 'no', 'true', 'false', 'y', 'n', 'da', 'nu', '1', '0']);

export function guessType(values: string[]): NewType {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (!filled.length) return 'text';
  const all = (re: RegExp) => filled.every((v) => re.test(v));
  if (filled.every((v) => YES_NO.has(v.toLowerCase())) && new Set(filled.map((v) => v.toLowerCase())).size <= 2) return 'checkbox';
  if (all(URL_RE)) return 'url';
  if (all(EMAIL_RE)) return 'email';
  if (all(DATE_RE)) return 'date';
  if (filled.every((v) => !Number.isNaN(Number(v.replace(',', '.'))))) return 'number';
  if (all(PHONE_RE)) return 'phone';
  const distinct = new Set(filled);
  if (distinct.size <= 12 && filled.length >= distinct.size * 2 && [...distinct].every((v) => v.length <= 60)) return 'select';
  return filled.some((v) => v.length > 120) ? 'long_text' : 'text';
}

/** A first guess for every column; the person can change each one. */
export function guessMapping(kind: 'companies' | 'contacts', header: string[], rows: string[][], fields: CustomField[], canCreate: boolean): Target[] {
  const used = new Set<string>();
  return header.map((h, i) => {
    const name = norm(h);
    const values = rows.map((r) => r[i] ?? '');
    if (['no', 'no.', 'nr', 'nr.', '#', 'id', 'row', 'index'].includes(name) || /^(no|nr|#)\.?$/.test(name)) return { kind: 'skip' };
    const field = IMPORT_FIELDS[kind].find((f) => !used.has(f.key) && f.names.includes(name));
    if (field) {
      used.add(field.key);
      return { kind: 'field', key: field.key };
    }
    const custom = fields.find((f) => f.entity === kind && (norm(f.label) === name || f.key === keyFor(h)));
    if (custom) return { kind: 'custom', key: custom.key };
    if (/source|sources|reference|evidence|comment/.test(name)) return { kind: 'notes' };
    if (!values.some((v) => v.trim())) return { kind: 'skip' };
    return canCreate ? { kind: 'new', label: h, type: guessType(values) } : { kind: 'notes' };
  });
}

const truthy = (v: string) => ['yes', 'true', 'y', 'da', '1'].includes(v.trim().toLowerCase());

function coerce(value: string, type: string): unknown {
  const v = value.trim();
  if (!v) return null;
  if (type === 'checkbox') return truthy(v);
  if (type === 'number') return Number(v.replace(',', '.'));
  if (type === 'url' && /^www\./i.test(v)) return `https://${v}`;
  return v;
}

/** Rows for crm_import, given the final mapping and the custom properties (including new ones). */
export function buildRows(kind: Kind, header: string[], rows: string[][], mapping: Target[], fields: CustomField[]) {
  return rows.map((row) => {
    const out: Record<string, unknown> = { custom: {} as Record<string, unknown> };
    const notes: string[] = [];
    let first = '';
    let last = '';
    mapping.forEach((t, i) => {
      const value = (row[i] ?? '').trim();
      if (!value || t.kind === 'skip') return;
      if (t.kind === 'notes') notes.push(`${header[i]}: ${value}`);
      else if (t.kind === 'field') {
        if (t.key === 'first_name') first = value;
        else if (t.key === 'last_name') last = value;
        else if (t.key === 'notes') notes.unshift(value);
        else if (t.key === 'tags') out.tags = value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
        else if (t.key === 'domain') out.domain = value.replace(/\/+$/, '');
        else out[t.key] = value;
      } else {
        const key = t.kind === 'custom' ? t.key : keyFor(t.label);
        const type = t.kind === 'new' ? t.type : fields.find((f) => f.entity === kind && f.key === t.key)?.field_type ?? 'text';
        const coerced = coerce(value, type);
        if (coerced !== null) (out.custom as Record<string, unknown>)[key] = coerced;
      }
    });
    if (!out.name && (first || last)) out.name = `${first} ${last}`.trim();
    if (notes.length) out.notes = notes.join('\n');
    return out;
  });
}

/** Distinct values of a column, for a new dropdown's choices. */
export const choicesFrom = (rows: string[][], i: number) => [...new Set(rows.map((r) => (r[i] ?? '').trim()).filter(Boolean))].slice(0, 50);
