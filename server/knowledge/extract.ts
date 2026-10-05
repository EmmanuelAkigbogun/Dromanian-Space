// Text extraction for knowledge indexing. Supported: text-based PDF, DOCX,
// TXT, Markdown, CSV. Anything else, encrypted or image-only content is
// reported with a specific status instead of being marked as indexed.

import { csvLine, parseCsv } from './csv.js';
import type { TextUnit } from './chunk.js';

export const MAX_EXTRACT_BYTES = 50 * 1024 * 1024;
export const MAX_TEXT_CHARS = 1_500_000;
const CSV_ROWS_PER_UNIT = 40;

export type FileKind = 'pdf' | 'docx' | 'csv' | 'markdown' | 'text';

export type Extraction =
  | {
      status: 'ok';
      units: TextUnit[];
      extractor: string;
      charCount: number;
      pageCount?: number;
      rowCount?: number;
      truncated: boolean;
    }
  | { status: 'unsupported' | 'too_large' | 'no_text' | 'encrypted'; code: string; message: string };

export function detectKind(mime: string | null | undefined, name: string | null | undefined): FileKind | null {
  const m = (mime ?? '').toLowerCase();
  const ext = (name ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') return 'docx';
  if (m === 'text/csv' || m === 'application/csv' || ext === 'csv') return 'csv';
  if (m === 'text/markdown' || m === 'text/x-markdown' || ext === 'md' || ext === 'markdown') return 'markdown';
  if (m === 'text/plain' || ext === 'txt') return 'text';
  return null;
}

function capUnits(units: TextUnit[]): { units: TextUnit[]; truncated: boolean; charCount: number } {
  let total = 0;
  const out: TextUnit[] = [];
  for (const u of units) {
    total += u.text.length;
    if (total > MAX_TEXT_CHARS) {
      const keep = u.text.length - (total - MAX_TEXT_CHARS);
      if (keep > 0) out.push({ ...u, text: u.text.slice(0, keep) });
      return { units: out, truncated: true, charCount: MAX_TEXT_CHARS };
    }
    out.push(u);
  }
  return { units: out, truncated: false, charCount: total };
}

function decodeText(bytes: Uint8Array): string | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const sample = text.slice(0, 20000);
  if (sample.length === 0) return '';
  let bad = 0;
  for (const ch of sample) {
    const code = ch.charCodeAt(0);
    if (ch === '�' || (code < 32 && ch !== '\n' && ch !== '\r' && ch !== '\t')) bad++;
  }
  // Mostly undecodable bytes: this is not a text file.
  if (bad / sample.length > 0.05) return null;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Splits Markdown/plain text into sections at headings, tracking character offsets. */
export function textUnits(text: string, markdown: boolean): TextUnit[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!markdown) {
    return normalized.trim() ? [{ text: normalized, location: { start_char: 0, end_char: normalized.length } }] : [];
  }
  const units: TextUnit[] = [];
  const headingRe = /^(#{1,6})\s+(.+)$/gm;
  let lastIndex = 0;
  let section: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(normalized)) !== null) {
    const body = normalized.slice(lastIndex, match.index);
    if (body.trim()) units.push({ text: body, location: { section, start_char: lastIndex, end_char: match.index } });
    section = match[2].trim().slice(0, 120);
    lastIndex = match.index;
  }
  const rest = normalized.slice(lastIndex);
  if (rest.trim()) units.push({ text: rest, location: { section, start_char: lastIndex, end_char: normalized.length } });
  return units;
}

export function csvUnits(text: string): { units: TextUnit[]; rowCount: number; columns: string[] } {
  const parsed = parseCsv(text);
  const header = csvLine(parsed.header, parsed.delimiter === '\t' ? '\t' : ',');
  const units: TextUnit[] = [];
  for (let start = 0; start < parsed.rows.length; start += CSV_ROWS_PER_UNIT) {
    const slice = parsed.rows.slice(start, start + CSV_ROWS_PER_UNIT);
    // Row numbers count the header as row 1, as spreadsheets do.
    const body = slice.map((r) => csvLine(r)).join('\n');
    units.push({ text: `${header}\n${body}`, location: { row_start: start + 2, row_end: start + slice.length + 1 } });
  }
  return { units, rowCount: parsed.rows.length, columns: parsed.header };
}

async function extractPdf(bytes: Uint8Array): Promise<Extraction> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'PasswordException') {
      return { status: 'encrypted', code: 'encrypted', message: 'This PDF is password-protected, so its text cannot be read.' };
    }
    return { status: 'unsupported', code: 'invalid_pdf', message: 'This PDF could not be opened. It may be damaged.' };
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const units: TextUnit[] = text
    .map((pageText, i) => ({ text: pageText.replace(/[ \t]+\n/g, '\n').trim(), location: { page: i + 1 } }))
    .filter((u) => u.text.length > 0);
  const chars = units.reduce((n, u) => n + u.text.length, 0);
  // Fewer than ~20 characters per page means there is no real text layer.
  if (chars < Math.max(20, totalPages * 20)) {
    return {
      status: 'no_text',
      code: 'no_text_layer',
      message: 'This PDF has no text layer (it looks scanned). Scanned documents need OCR, which is not supported yet.',
    };
  }
  const capped = capUnits(units);
  return { status: 'ok', extractor: 'unpdf', pageCount: totalPages, ...capped };
}

async function extractDocx(bytes: Uint8Array): Promise<Extraction> {
  // Password-protected Office files are OLE containers, not ZIP packages.
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return {
      status: 'encrypted',
      code: 'encrypted_or_legacy',
      message: 'This Word file is password-protected or in the old .doc format, so its text cannot be read.',
    };
  }
  const mammoth = (await import('mammoth')).default;
  let value: string;
  try {
    ({ value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) }));
  } catch {
    return { status: 'unsupported', code: 'invalid_docx', message: 'This Word document could not be opened. It may be damaged.' };
  }
  const units = textUnits(value, false);
  if (units.length === 0) return { status: 'no_text', code: 'empty', message: 'This document contains no text.' };
  const capped = capUnits(units);
  return { status: 'ok', extractor: 'mammoth', ...capped };
}

export async function extractFile(bytes: Uint8Array, kind: FileKind): Promise<Extraction> {
  if (bytes.byteLength > MAX_EXTRACT_BYTES) {
    return { status: 'too_large', code: 'too_large', message: 'This file is larger than 50 MB and is not indexed.' };
  }
  if (kind === 'pdf') return extractPdf(bytes);
  if (kind === 'docx') return extractDocx(bytes);
  const text = decodeText(bytes);
  if (text === null) {
    return { status: 'unsupported', code: 'not_text', message: 'This file does not contain readable text.' };
  }
  if (!text.trim()) return { status: 'no_text', code: 'empty', message: 'This file is empty.' };
  if (kind === 'csv') {
    const { units, rowCount } = csvUnits(text);
    if (units.length === 0) return { status: 'no_text', code: 'empty', message: 'This CSV file has no data rows.' };
    const capped = capUnits(units);
    return { status: 'ok', extractor: 'csv', rowCount, ...capped };
  }
  const capped = capUnits(textUnits(text, kind === 'markdown'));
  return { status: 'ok', extractor: kind, ...capped };
}

/** Internal documents are Markdown: title plus body. */
export function extractDocument(title: string, body: string): Extraction {
  const text = `# ${title}\n\n${body ?? ''}`;
  if (!(body ?? '').trim()) return { status: 'no_text', code: 'empty', message: 'This document is empty.' };
  const capped = capUnits(textUnits(text, true));
  return { status: 'ok', extractor: 'document', ...capped };
}
