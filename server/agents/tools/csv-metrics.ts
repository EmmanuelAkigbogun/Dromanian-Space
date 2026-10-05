import { z } from 'zod';
import { rpc, serviceClient } from '../../supabase.js';
import { parseCsv } from '../../knowledge/csv.js';
import { defineTool } from './types.js';

const MAX_CSV_BYTES = 20 * 1024 * 1024;
const MAX_GROUPS = 50;

const Operation = z.object({
  op: z.enum(['count', 'count_non_empty', 'count_empty', 'count_distinct', 'sum', 'avg', 'min', 'max']),
  column: z.string().max(200).optional().describe('Column name (not needed for count)'),
});

const Filter = z.object({
  column: z.string().max(200),
  op: z.enum(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty']),
  value: z.string().max(500).optional(),
});

export type MetricsInput = {
  operations: Array<z.infer<typeof Operation>>;
  filters?: Array<z.infer<typeof Filter>>;
  group_by?: string;
};

/** Parses numbers written as 1234.5, 1,234.50, $1,234 or (12) — never guesses beyond that. */
export function parseNumber(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^[$€£¥]\s?/, '').replace(/\s?[$€£¥%]$/, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

function columnIndex(header: string[], name: string): number {
  const exact = header.indexOf(name);
  if (exact >= 0) return exact;
  const lower = name.trim().toLowerCase();
  return header.findIndex((h) => h.trim().toLowerCase() === lower);
}

function matches(value: string, f: z.infer<typeof Filter>): boolean {
  const v = value.trim();
  const target = (f.value ?? '').trim();
  switch (f.op) {
    case 'empty':
      return v === '';
    case 'not_empty':
      return v !== '';
    case 'eq':
      return v.toLowerCase() === target.toLowerCase();
    case 'neq':
      return v.toLowerCase() !== target.toLowerCase();
    case 'contains':
      return v.toLowerCase().includes(target.toLowerCase());
    default: {
      const a = parseNumber(v);
      const b = parseNumber(target);
      if (a === null || b === null) return false;
      return f.op === 'gt' ? a > b : f.op === 'gte' ? a >= b : f.op === 'lt' ? a < b : a <= b;
    }
  }
}

interface Accumulator {
  count: number;
  nonEmpty: number;
  numeric: number;
  nonNumeric: number;
  sum: number;
  min: number | null;
  max: number | null;
  distinct: Set<string>;
}

function newAcc(): Accumulator {
  return { count: 0, nonEmpty: 0, numeric: 0, nonNumeric: 0, sum: 0, min: null, max: null, distinct: new Set() };
}

/** Vetted aggregate operations over parsed rows. Pure; unit tested. */
export function computeMetrics(header: string[], rows: string[][], input: MetricsInput) {
  const missing = [
    ...input.operations.filter((o) => o.op !== 'count').map((o) => o.column ?? ''),
    ...(input.filters ?? []).map((f) => f.column),
    ...(input.group_by ? [input.group_by] : []),
  ].filter((c) => columnIndex(header, c) < 0);
  if (missing.length) return { error: `Unknown column(s): ${[...new Set(missing)].join(', ')}. Columns: ${header.join(', ')}` };

  const filters = (input.filters ?? []).map((f) => ({ f, idx: columnIndex(header, f.column) }));
  const groupIdx = input.group_by ? columnIndex(header, input.group_by) : -1;
  const groups = new Map<string, Accumulator[]>();
  let matched = 0;

  for (const row of rows) {
    if (!filters.every(({ f, idx }) => matches(row[idx] ?? '', f))) continue;
    matched++;
    const key = groupIdx >= 0 ? (row[groupIdx] ?? '').trim() || '(empty)' : '__all__';
    let accs = groups.get(key);
    if (!accs) {
      accs = input.operations.map(() => newAcc());
      groups.set(key, accs);
    }
    input.operations.forEach((op, i) => {
      const acc = accs![i];
      acc.count++;
      if (op.op === 'count') return;
      const raw = (row[columnIndex(header, op.column!)] ?? '').trim();
      if (raw !== '') acc.nonEmpty++;
      if (op.op === 'count_distinct' && raw !== '') acc.distinct.add(raw.toLowerCase());
      if (['sum', 'avg', 'min', 'max'].includes(op.op) && raw !== '') {
        const n = parseNumber(raw);
        if (n === null) acc.nonNumeric++;
        else {
          acc.numeric++;
          acc.sum += n;
          acc.min = acc.min === null ? n : Math.min(acc.min, n);
          acc.max = acc.max === null ? n : Math.max(acc.max, n);
        }
      }
    });
  }

  const value = (op: z.infer<typeof Operation>, acc: Accumulator): number | null => {
    switch (op.op) {
      case 'count':
        return acc.count;
      case 'count_non_empty':
        return acc.nonEmpty;
      case 'count_empty':
        return acc.count - acc.nonEmpty;
      case 'count_distinct':
        return acc.distinct.size;
      case 'sum':
        return acc.numeric ? Number(acc.sum.toFixed(10)) : null;
      case 'avg':
        return acc.numeric ? Number((acc.sum / acc.numeric).toFixed(10)) : null;
      case 'min':
        return acc.min;
      case 'max':
        return acc.max;
    }
  };

  const ordered = [...groups.entries()].sort((a, b) => b[1][0].count - a[1][0].count);
  const results = ordered.slice(0, MAX_GROUPS).map(([key, accs]) => ({
    group: groupIdx >= 0 ? key : null,
    values: input.operations.map((op, i) => ({
      op: op.op,
      column: op.column ?? null,
      value: value(op, accs[i]),
      skipped_non_numeric: accs[i].nonNumeric || undefined,
    })),
  }));
  return { matched_rows: matched, groups_total: groups.size, groups_shown: results.length, results };
}

interface FileRow {
  item_id: string;
  name: string;
  version_id: string;
  bucket: string;
  path: string;
  mime_type: string;
  size_bytes: number;
}

export const computeCsvMetrics = defineTool({
  name: 'compute_csv_metrics',
  description:
    'Compute counts, sums, averages, minimums, maximums and distinct counts over a CSV file the requester can open, with optional filters and one group-by column. Set describe=true first to see the columns and a few sample rows. Report only numbers this tool returns.',
  schema: z.object({
    item_id: z.string().uuid().describe('Drive item id of the CSV file'),
    describe: z.boolean().optional().describe('Return columns, row count and sample rows instead of metrics'),
    operations: z.array(Operation).max(10).optional(),
    filters: z.array(Filter).max(10).optional(),
    group_by: z.string().max(200).optional(),
  }),
  label: (i) => (i.describe ? 'Inspecting a CSV file' : 'Calculating metrics'),
  async run(ctx, input) {
    if (ctx.allowedItemIds && !ctx.allowedItemIds.includes(input.item_id)) {
      return { content: 'This file is not among the sources this agent may use.', summary: { error: 'out_of_scope' }, isError: true };
    }
    const [file] = await rpc<FileRow[]>('agent_file_for', { p_actor: ctx.actorId, p_item_id: input.item_id });
    if (!file) return { content: 'File not found, or the requester cannot open it.', summary: { error: 'not_found' }, isError: true };
    const isCsv = /csv/i.test(file.mime_type) || /\.csv$/i.test(file.name);
    if (!isCsv) return { content: `"${file.name}" is not a CSV file.`, summary: { error: 'not_csv' }, isError: true };
    if (file.size_bytes > MAX_CSV_BYTES) {
      return { content: `"${file.name}" is larger than 20 MB, which this tool does not process.`, summary: { error: 'too_large' }, isError: true };
    }
    const { data, error } = await serviceClient().storage.from(file.bucket).download(file.path);
    if (error || !data) return { content: 'The stored file could not be read.', summary: { error: 'download_failed' }, isError: true };
    const parsed = parseCsv(await data.text(), 500_000);
    await ctx.recordSource('drive_item', file.item_id, { itemId: file.item_id, label: file.name });

    const provenance = { file: file.name, item_id: file.item_id, version_id: file.version_id, rows: parsed.rows.length };
    if (input.describe || !input.operations?.length) {
      return {
        content: JSON.stringify({
          ...provenance,
          columns: parsed.header,
          sample_rows: parsed.rows.slice(0, 5),
          truncated: parsed.truncated || undefined,
        }),
        summary: { file: file.name, rows: parsed.rows.length, columns: parsed.header.length },
      };
    }
    const result = computeMetrics(parsed.header, parsed.rows, {
      operations: input.operations,
      filters: input.filters,
      group_by: input.group_by,
    });
    if ('error' in result) return { content: result.error ?? 'Invalid request', summary: { error: 'bad_columns' }, isError: true };
    return {
      content: JSON.stringify({ ...provenance, ...result, truncated: parsed.truncated || undefined }),
      summary: { file: file.name, matched_rows: result.matched_rows, groups: result.groups_total },
    };
  },
});
