// Reads CSV and Excel (.xlsx) files into a header row and data rows for the
// CRM import, and writes CSV for export. Excel files are unzipped with fflate
// and their XML read directly: shared or inline strings, namespaced tags, an
// Excel table's range when there is one, and title rows above the header.
import { strFromU8, unzipSync } from 'fflate';

export interface Sheet {
  name: string;
  header: string[];
  rows: string[][];
}

export const MAX_ROWS = 5000;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const delimiter = detectDelimiter(text);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

export function toCsv(header: string[], rows: string[][]): string {
  const cell = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return [header, ...rows].map((r) => r.map((v) => cell(v ?? '')).join(',')).join('\r\n');
}

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** Text of every <t> run inside an element (rich text has several). */
const runs = (xml: string) => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decode(m[1])).join('');

const columnIndex = (ref: string) => {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

const excelDate = (serial: number) => new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);

export function parseXlsx(data: Uint8Array): Sheet[] {
  const files = unzipSync(data, { filter: (f) => f.name.startsWith('xl/') && f.name.endsWith('.xml') || f.name.endsWith('.rels') });
  const read = (name: string) => (files[name] ? strFromU8(files[name]) : '');
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => runs(m[1]));
  const dateStyles = dateStyleIndexes(read('xl/styles.xml'));

  // Sheet names in workbook order, resolved to their files through the rels.
  const rels = new Map(
    [...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      m[0].match(/Id="([^"]+)"/)?.[1] ?? '',
      (m[0].match(/Target="([^"]+)"/)?.[1] ?? '').replace(/^\/?(xl\/)?/, 'xl/'),
    ]),
  );
  const sheets = [...read('xl/workbook.xml').matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)].map((m) => ({
    name: decode(m[0].match(/name="([^"]+)"/)?.[1] ?? 'Sheet'),
    file: rels.get(m[0].match(/r:id="([^"]+)"/)?.[1] ?? '') ?? '',
  }));

  return sheets
    .map(({ name, file }) => {
      const xml = read(file);
      const grid: string[][] = [];
      for (const row of xml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
        const r = Number(row[1].match(/\br="(\d+)"/)?.[1] ?? grid.length + 1) - 1;
        if (r > MAX_ROWS + 50) break;
        const cells: string[] = [];
        for (const c of row[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
          const attrs = c[1];
          const body = c[2] ?? '';
          const col = columnIndex(attrs.match(/\br="([A-Z]+)\d+"/)?.[1] ?? String.fromCharCode(65 + cells.length));
          const type = attrs.match(/\bt="(\w+)"/)?.[1];
          const raw = body.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
          const style = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? -1);
          let value = '';
          if (type === 's' && raw !== undefined) value = shared[Number(raw)] ?? '';
          else if (type === 'inlineStr') value = runs(body);
          else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
          else if (raw !== undefined) value = !type && dateStyles.has(style) && !Number.isNaN(Number(raw)) ? excelDate(Number(raw)) : decode(raw);
          cells[col] = value.trim();
        }
        grid[r] = Array.from(cells, (v) => v ?? '');
      }
      const rows = Array.from(grid, (r) => r ?? []);
      const tableRef = tableRange(files, read, file);
      return toSheet(name, rows, tableRef);
    })
    .filter((s) => s.header.length > 0);
}

/** Styles whose number format is a date, so serial numbers read as dates. */
function dateStyleIndexes(styles: string): Set<number> {
  const custom = new Map(
    [...styles.matchAll(/<(?:\w+:)?numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [Number(m[1]), m[2]]),
  );
  const xfs = styles.match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/)?.[1] ?? '';
  const result = new Set<number>();
  [...xfs.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)].forEach((m, i) => {
    const id = Number(m[0].match(/numFmtId="(\d+)"/)?.[1] ?? 0);
    const code = custom.get(id) ?? '';
    if ((id >= 14 && id <= 22) || (/[dmy]/i.test(code.replace(/"[^"]*"/g, '')) && !/[h]/i.test(code))) result.add(i);
  });
  return result;
}

/** The first Excel table on a sheet, as zero-based [startRow, startCol, endRow, endCol]. */
function tableRange(files: Record<string, Uint8Array>, read: (n: string) => string, sheetFile: string): number[] | null {
  const relsFile = sheetFile.replace(/worksheets\/([^/]+)$/, 'worksheets/_rels/$1.rels');
  const target = read(relsFile).match(/Target="([^"]*tables\/[^"]+)"/)?.[1];
  if (!target) return null;
  const tableFile = `xl/tables/${target.split('/').pop()}`;
  if (!files[tableFile]) return null;
  const ref = read(tableFile).match(/\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/);
  if (!ref) return null;
  return [Number(ref[2]) - 1, columnIndex(ref[1]), Number(ref[4]) - 1, columnIndex(ref[3])];
}

/**
 * The header is the table's first row when the sheet has an Excel table;
 * otherwise the first of the opening rows with the most filled cells (title
 * rows above a table have one or two).
 */
function toSheet(name: string, grid: string[][], table: number[] | null): Sheet {
  let rows = grid;
  if (table) {
    const [r0, c0, r1, c1] = table;
    rows = grid.slice(r0, r1 + 1).map((r) => Array.from({ length: c1 - c0 + 1 }, (_, i) => r[c0 + i] ?? ''));
  } else {
    const filled = (r: string[] | undefined) => (r ?? []).filter((v) => v !== '').length;
    const window = grid.slice(0, 25);
    const most = Math.max(0, ...window.map(filled));
    const start = window.findIndex((r) => filled(r) >= Math.max(2, Math.ceil(most * 0.6)));
    rows = start === -1 ? grid : grid.slice(start);
  }
  const header = (rows[0] ?? []).map((h, i) => h || `Column ${i + 1}`);
  const body = rows
    .slice(1)
    .filter((r) => r.some((v) => v !== ''))
    .slice(0, MAX_ROWS)
    .map((r) => header.map((_, i) => r[i] ?? ''));
  return { name, header: body.length || header.some((h) => !h.startsWith('Column ')) ? header : [], rows: body };
}

export async function readSpreadsheet(file: Blob, fileName: string): Promise<Sheet[]> {
  if (/\.xlsx$/i.test(fileName)) return parseXlsx(new Uint8Array(await file.arrayBuffer()));
  if (/\.(csv|tsv|txt)$/i.test(fileName)) {
    const grid = parseCsv((await file.text()).replace(/^﻿/, ''));
    return [toSheet(fileName.replace(/\.[^.]+$/, ''), grid, null)];
  }
  throw new Error('Choose a .csv or .xlsx file.');
}
