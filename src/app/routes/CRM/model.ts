// The CRM's record model, after OpenCRM (MIT, clawnify/OpenCRM): the columns
// each list shows, how a cell reads and writes its value, how a view's
// filters become a PostgREST query, and the footer calculations.
import type { Row } from '@/features/platform/client';

export type Kind = 'contacts' | 'companies' | 'deals';
export type Company = Row<'crm_companies'>;
export type Contact = Row<'crm_contacts'>;
export type Deal = Row<'crm_deals'>;
export type CrmRecord = Company | Contact | Deal;
export type Stage = Row<'crm_stages'>;
export type Pipeline = Row<'crm_pipelines'>;
export type CustomField = Row<'crm_custom_fields'>;
export type SavedView = Row<'crm_views'>;
export interface Person {
  id: string;
  display_name: string | null;
  username: string | null;
}

export const TABLES: Record<Kind, 'crm_companies' | 'crm_contacts' | 'crm_deals'> = {
  companies: 'crm_companies',
  contacts: 'crm_contacts',
  deals: 'crm_deals',
};
export const SINGULAR: Record<Kind, string> = { companies: 'company', contacts: 'contact', deals: 'deal' };
export const LIFECYCLE = ['lead', 'qualified', 'customer', 'former_customer'];
export const STAGE_COLORS = ['slate', 'sky', 'teal', 'emerald', 'amber', 'orange', 'rose', 'fuchsia', 'violet'] as const;

export type ColumnType =
  | 'text' | 'long_text' | 'number' | 'money' | 'date' | 'datetime' | 'checkbox'
  | 'enum' | 'tags' | 'url' | 'email' | 'phone' | 'person' | 'company' | 'contact';

export interface Option {
  value: string;
  label: string;
  color?: string;
}

export interface Column {
  /** Stable id: a column name, or custom.<key> for a custom property. */
  key: string;
  label: string;
  type: ColumnType;
  /** The PostgREST column expression to filter and sort on. */
  field: string;
  editable: boolean;
  width: number;
  options?: Option[];
  /** Shown unless a view hides it. */
  shown: boolean;
  /** Free text, offering the values already used in this column. */
  suggest?: boolean;
}

export interface Context {
  people: Person[];
  companies: Pick<Company, 'id' | 'name'>[];
  contacts: Pick<Contact, 'id' | 'name'>[];
  stages: Stage[];
  pipelines: Pipeline[];
  fields: CustomField[];
}

export const personName = (p: Person | undefined) => p?.display_name || p?.username || 'Former member';

function base(kind: Kind, ctx: Context): Column[] {
  const people: Option[] = ctx.people.map((p) => ({ value: p.id, label: personName(p) }));
  const col = (key: string, label: string, type: ColumnType, width: number, extra: Partial<Column> = {}): Column => ({
    key, label, type, field: key, editable: true, width, shown: true, ...extra,
  });
  const meta = [
    col('owner_id', 'Owner', 'person', 150, { options: people }),
    col('created_at', 'Created', 'datetime', 130, { editable: false, shown: false }),
    col('updated_at', 'Last updated', 'datetime', 130, { editable: false }),
  ];
  if (kind === 'companies') {
    return [
      // The team's prospect-list columns, in its order.
      col('name', 'Name', 'text', 230),
      col('email', 'Email', 'email', 200),
      col('industry', 'Sector', 'text', 160, { suggest: true }),
      col('phone', 'Phone number', 'phone', 150),
      col('has_linkedin', 'Has LinkedIn?', 'checkbox', 110),
      col('domain', 'Website', 'url', 190),
      col('linkedin_url', 'LinkedIn URL', 'url', 220),
      col('listed_location', 'Listed location', 'text', 170, { suggest: true }),
      col('prospect_type', 'Prospect type', 'text', 180, { suggest: true }),
      col('contact_status', 'Contact status', 'text', 190, { suggest: true }),
      col('contact_sources', 'Contact source URL(s)', 'url', 220),
      col('location_source', 'Location / LinkedIn source', 'url', 220),
      col('customer_since', 'Customer since', 'date', 140, { shown: false }),
      col('renewal_date', 'Renewal', 'date', 130, { shown: false }),
      ...meta,
    ];
  }
  if (kind === 'contacts') {
    return [
      col('name', 'Name', 'text', 220),
      col('email', 'Email', 'email', 210),
      col('phone', 'Phone', 'phone', 140),
      col('title', 'Job title', 'text', 160),
      col('company_id', 'Company', 'company', 180, { options: ctx.companies.map((c) => ({ value: c.id, label: c.name })) }),
      col('lifecycle_stage', 'Lifecycle', 'enum', 130, { options: LIFECYCLE.map((v) => ({ value: v, label: humanize(v) })) }),
      col('tags', 'Tags', 'tags', 170, { shown: false }),
      ...meta,
    ];
  }
  return [
    col('name', 'Deal', 'text', 230),
    col('value', 'Value', 'money', 130),
    col('stage_id', 'Stage', 'enum', 150, {
      options: ctx.stages.map((s) => ({ value: s.id, label: s.name, color: s.color })),
    }),
    col('company_id', 'Company', 'company', 170, { options: ctx.companies.map((c) => ({ value: c.id, label: c.name })) }),
    col('contact_id', 'Contact', 'contact', 160, { options: ctx.contacts.map((c) => ({ value: c.id, label: c.name })) }),
    col('expected_close', 'Close date', 'date', 130),
    col('pipeline_id', 'Pipeline', 'enum', 140, { editable: false, shown: false, options: ctx.pipelines.map((p) => ({ value: p.id, label: p.name })) }),
    ...meta,
  ];
}

const CUSTOM_TYPES: Record<string, ColumnType> = {
  text: 'text', long_text: 'long_text', number: 'number', checkbox: 'checkbox', date: 'date',
  select: 'enum', url: 'url', email: 'email', phone: 'phone', tags: 'tags',
};

export function choicesOf(field: CustomField): string[] {
  const choices = (field.options as { choices?: unknown } | null)?.choices;
  return Array.isArray(choices) ? choices.map(String) : [];
}

export function columnsFor(kind: Kind, ctx: Context): Column[] {
  const custom = ctx.fields
    .filter((f) => f.entity === kind)
    .sort((a, b) => a.position - b.position)
    .map<Column>((f) => ({
      key: `custom.${f.key}`,
      label: f.label,
      type: CUSTOM_TYPES[f.field_type] ?? 'text',
      field: `custom->>${f.key}`,
      editable: true,
      width: 150,
      shown: true,
      options: f.field_type === 'select' ? choicesOf(f).map((c) => ({ value: c, label: c })) : undefined,
    }));
  return [...base(kind, ctx), ...custom];
}

export function readValue(record: CrmRecord, column: Column): unknown {
  if (column.key.startsWith('custom.')) return (record.custom as Record<string, unknown> | null)?.[column.key.slice(7)] ?? null;
  return (record as unknown as Record<string, unknown>)[column.key] ?? null;
}

/** The update that stores a new value in a cell. */
export function patchFor(record: CrmRecord, column: Column, value: unknown): Record<string, unknown> {
  if (column.key.startsWith('custom.')) {
    const custom = { ...((record.custom as Record<string, unknown> | null) ?? {}) };
    if (value === null || value === '' || (Array.isArray(value) && !value.length)) delete custom[column.key.slice(7)];
    else custom[column.key.slice(7)] = value;
    return { custom };
  }
  return { [column.key]: value === '' ? null : value };
}

export function displayValue(record: CrmRecord, column: Column): string {
  const v = readValue(record, column);
  if (v === null || v === undefined || v === '') return '';
  switch (column.type) {
    case 'money':
      return formatMoney(Number(v), (record as Deal).currency);
    case 'number':
      return Number(v).toLocaleString();
    case 'date':
      return formatDate(String(v));
    case 'datetime':
      return formatDate(String(v));
    case 'checkbox':
      return v === true || v === 'true' ? 'Yes' : 'No';
    case 'tags':
      return Array.isArray(v) ? v.join(', ') : String(v);
    default:
      if (column.options) return column.options.find((o) => o.value === v)?.label ?? String(v);
      return String(v);
  }
}

export const humanize = (s: string) => (s.charAt(0).toUpperCase() + s.slice(1)).replaceAll('_', ' ');
export const formatMoney = (value: number, currency = 'EUR') => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString()}`;
  }
};
export const formatDate = (value: string) => {
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

// ── Filters ─────────────────────────────────────────────────────────────────

export interface Rule {
  field: string;
  op: string;
  value?: string | string[];
}

export interface ViewState {
  rules: Rule[];
  match: 'all' | 'any';
  sort: string | null;
  sortDesc: boolean;
  /** Per column: hidden, footer calculation. */
  columns: Record<string, { hidden?: boolean; aggregate?: string }>;
}

export const EMPTY_VIEW: ViewState = { rules: [], match: 'all', sort: null, sortDesc: false, columns: {} };

type FilterKind = 'text' | 'number' | 'date' | 'choice' | 'checkbox';
export const filterKind = (type: ColumnType): FilterKind =>
  type === 'number' || type === 'money' ? 'number'
    : type === 'date' || type === 'datetime' ? 'date'
      : type === 'checkbox' ? 'checkbox'
        : type === 'enum' || type === 'person' || type === 'company' || type === 'contact' || type === 'tags' ? 'choice'
          : 'text';

export const OPERATORS: Record<FilterKind, { op: string; label: string }[]> = {
  text: [
    { op: 'contains', label: 'contains' }, { op: 'not_contains', label: 'does not contain' },
    { op: 'is', label: 'is' }, { op: 'is_not', label: 'is not' },
    { op: 'empty', label: 'is empty' }, { op: 'not_empty', label: 'is not empty' },
  ],
  number: [
    { op: 'eq', label: '=' }, { op: 'neq', label: '≠' }, { op: 'gt', label: '>' }, { op: 'gte', label: '≥' },
    { op: 'lt', label: '<' }, { op: 'lte', label: '≤' }, { op: 'empty', label: 'is empty' }, { op: 'not_empty', label: 'is not empty' },
  ],
  date: [
    { op: 'on', label: 'is' }, { op: 'before', label: 'is before' }, { op: 'after', label: 'is on or after' },
    { op: 'last_days', label: 'in the last … days' }, { op: 'next_days', label: 'in the next … days' },
    { op: 'past', label: 'is in the past' }, { op: 'future', label: 'is in the future' },
    { op: 'empty', label: 'is empty' }, { op: 'not_empty', label: 'is not empty' },
  ],
  choice: [
    { op: 'any', label: 'is any of' }, { op: 'none', label: 'is none of' },
    { op: 'empty', label: 'is empty' }, { op: 'not_empty', label: 'is not empty' },
  ],
  checkbox: [{ op: 'checked', label: 'is checked' }, { op: 'unchecked', label: 'is not checked' }],
};

const VALUELESS = new Set(['empty', 'not_empty', 'past', 'future', 'checked', 'unchecked']);
export const needsValue = (op: string) => !VALUELESS.has(op);
export const ruleComplete = (r: Rule) => !needsValue(r.op) || (Array.isArray(r.value) ? r.value.length > 0 : !!r.value);

const quote = (v: string) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const like = (v: string) => `*${v.replaceAll('*', '').replaceAll(',', ' ')}*`;
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

/** One rule as PostgREST [column, "op.value"] pairs (ANDed). */
export function ruleToFilters(rule: Rule, column: Column): [string, string][] {
  const f = column.field;
  const v = Array.isArray(rule.value) ? rule.value : rule.value ?? '';
  const one = String(Array.isArray(v) ? v[0] ?? '' : v);
  const list = Array.isArray(v) ? v : [v];
  const isTags = column.type === 'tags';
  switch (rule.op) {
    case 'contains': return [[f, `ilike.${like(one)}`]];
    case 'not_contains': return [[f, `not.ilike.${like(one)}`]];
    case 'is': return [[f, `ilike.${one.replaceAll('*', '')}`]];
    case 'is_not': return [[f, `not.ilike.${one.replaceAll('*', '')}`]];
    case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte': return [[f, `${rule.op}.${Number(one) || 0}`]];
    case 'on': return [[f, `gte.${one}`], [f, `lt.${nextDay(one)}`]];
    case 'before': return [[f, `lt.${one}`]];
    case 'after': return [[f, `gte.${one}`]];
    case 'last_days': return [[f, `gte.${day(-Math.abs(Number(one) || 7))}`], [f, `lte.${day(0)}T23:59:59`]];
    case 'next_days': return [[f, `gte.${day(0)}`], [f, `lte.${day(Math.abs(Number(one) || 7))}`]];
    case 'past': return [[f, `lt.${day(0)}`]];
    case 'future': return [[f, `gt.${day(0)}`]];
    case 'any': return isTags ? [[f, `ov.{${list.map(quote).join(',')}}`]] : [[f, `in.(${list.map(quote).join(',')})`]];
    case 'none': return isTags ? [[f, `not.ov.{${list.map(quote).join(',')}}`]] : [[f, `not.in.(${list.map(quote).join(',')})`]];
    case 'empty': return isTags ? [[f, 'eq.{}']] : [[f, 'is.null']];
    case 'not_empty': return isTags ? [[f, 'neq.{}']] : [[f, 'not.is.null']];
    case 'checked': return [[f, 'eq.true']];
    case 'unchecked': return [[f, 'not.eq.true']];
    default: return [];
  }
}

function nextDay(date: string) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A filter for PostgREST's or=(…) list. */
const orPart = ([column, expr]: [string, string]) => `${column}.${expr}`;

interface Filterable {
  filter(column: string, operator: string, value: string): Filterable;
  or(filters: string): Filterable;
}

export function applyView<Q extends Filterable>(query: Q, view: ViewState, columns: Column[]): Q {
  const parts = view.rules
    .filter(ruleComplete)
    .map((r) => {
      const column = columns.find((c) => c.key === r.field);
      return column ? ruleToFilters(r, column) : [];
    })
    .filter((p) => p.length);
  if (view.match === 'any' && parts.length > 1) {
    query.or(parts.map((p) => (p.length === 1 ? orPart(p[0]) : `and(${p.map(orPart).join(',')})`)).join(','));
    return query;
  }
  for (const [column, expr] of parts.flat()) {
    const dot = expr.startsWith('not.') ? expr.indexOf('.', 4) : expr.indexOf('.');
    query.filter(column, expr.slice(0, dot), expr.slice(dot + 1));
  }
  return query;
}

/** Saved views store their rules as OpenCRM's filter tree: rules, or one any-group. */
export function viewFromSaved(saved: SavedView): ViewState {
  const filters = Array.isArray(saved.filters) ? (saved.filters as unknown[]) : [];
  const group = filters.length === 1 && (filters[0] as { logic?: string; rules?: unknown[] })?.logic === 'or'
    ? (filters[0] as { rules: Rule[] })
    : null;
  return {
    rules: group ? group.rules : (filters as Rule[]),
    match: group ? 'any' : 'all',
    sort: saved.sort,
    sortDesc: saved.sort_desc,
    columns: (saved.columns as ViewState['columns']) ?? {},
  };
}

export function savedFromView(view: ViewState) {
  const rules = view.rules.filter(ruleComplete);
  return {
    filters: view.match === 'any' && rules.length > 1 ? [{ logic: 'or', rules }] : rules,
    sort: view.sort,
    sort_desc: view.sortDesc,
    columns: view.columns,
  };
}

export const sameView = (a: ViewState, b: ViewState) => JSON.stringify(savedFromView(a)) === JSON.stringify(savedFromView(b));

// ── Footer calculations ─────────────────────────────────────────────────────

export const AGGREGATES: Record<string, string> = {
  count_filled: 'Filled',
  count_empty: 'Empty',
  percent_filled: 'Percent filled',
  unique: 'Unique',
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  earliest: 'Earliest',
  latest: 'Latest',
};

export function aggregatesFor(type: ColumnType): string[] {
  const basic = ['count_filled', 'count_empty', 'percent_filled', 'unique'];
  if (type === 'number' || type === 'money') return [...basic, 'sum', 'avg', 'min', 'max'];
  if (type === 'date' || type === 'datetime') return [...basic, 'earliest', 'latest'];
  return basic;
}

export function aggregate(records: CrmRecord[], column: Column, op: string): string {
  const values = records.map((r) => readValue(r, column));
  const filled = values.filter((v) => v !== null && v !== '' && !(Array.isArray(v) && !v.length));
  const nums = filled.map(Number).filter((n) => !Number.isNaN(n));
  const money = (n: number) => (column.type === 'money' ? formatMoney(n, (records[0] as Deal | undefined)?.currency) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));
  switch (op) {
    case 'count_filled': return String(filled.length);
    case 'count_empty': return String(values.length - filled.length);
    case 'percent_filled': return values.length ? `${Math.round((filled.length / values.length) * 100)}%` : '0%';
    case 'unique': return String(new Set(filled.map((v) => JSON.stringify(v))).size);
    case 'sum': return money(nums.reduce((a, b) => a + b, 0));
    case 'avg': return nums.length ? money(nums.reduce((a, b) => a + b, 0) / nums.length) : '–';
    case 'min': return nums.length ? money(Math.min(...nums)) : '–';
    case 'max': return nums.length ? money(Math.max(...nums)) : '–';
    case 'earliest': return filled.length ? formatDate(filled.map(String).sort()[0]) : '–';
    case 'latest': return filled.length ? formatDate(filled.map(String).sort().at(-1)!) : '–';
    default: return '';
  }
}
