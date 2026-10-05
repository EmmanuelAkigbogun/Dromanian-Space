// Splits extracted text into bounded chunks with stable locations.

export type Location = {
  page?: number;
  page_end?: number;
  section?: string;
  start_char?: number;
  end_char?: number;
  row_start?: number;
  row_end?: number;
};

/** A piece of extracted text with its position in the source (a page, a section, a block of CSV rows). */
export interface TextUnit {
  text: string;
  location: Location;
}

export interface Chunk {
  index: number;
  content: string;
  location: Location;
  tokens: number;
}

export interface ChunkOptions {
  target?: number;
  overlap?: number;
  maxChunks?: number;
}

const HARD_MAX = 7500; // knowledge_chunks.content allows up to 8000 characters

function mergeLocation(first: Location, last: Location): Location {
  const loc: Location = { ...first };
  if (first.page !== undefined && last.page !== undefined && last.page !== first.page) loc.page_end = last.page;
  if (last.end_char !== undefined) loc.end_char = last.end_char;
  if (first.row_start !== undefined && last.row_end !== undefined) loc.row_end = last.row_end;
  return loc;
}

function splitLong(text: string, size: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('. ', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

function tail(text: string, size: number): string {
  if (text.length <= size) return text;
  const slice = text.slice(text.length - size);
  const space = slice.indexOf(' ');
  return space > 0 ? slice.slice(space + 1) : slice;
}

/**
 * Packs paragraphs into chunks of about `target` characters. Units that carry
 * row ranges (CSV) are never merged across a chunk boundary mid-unit, and
 * receive no overlap, so row ranges stay exact.
 */
export function chunkUnits(units: TextUnit[], options: ChunkOptions = {}): { chunks: Chunk[]; truncated: boolean } {
  const target = options.target ?? 1400;
  const overlap = options.overlap ?? 200;
  const maxChunks = options.maxChunks ?? 1500;
  const chunks: Chunk[] = [];
  let truncated = false;

  let buffer = '';
  let bufFirst: Location | null = null;
  let bufLast: Location | null = null;

  const flush = (carry: boolean) => {
    const content = buffer.trim();
    if (content && bufFirst && bufLast) {
      if (chunks.length >= maxChunks) {
        truncated = true;
      } else {
        chunks.push({
          index: chunks.length,
          content: content.slice(0, HARD_MAX),
          location: mergeLocation(bufFirst, bufLast),
          tokens: Math.ceil(content.length / 4),
        });
      }
    }
    if (carry && content && overlap > 0) {
      buffer = tail(content, overlap) + '\n\n';
      bufFirst = bufLast;
    } else {
      buffer = '';
      bufFirst = null;
    }
    bufLast = null;
  };

  for (const unit of units) {
    if (truncated) break;
    const rowUnit = unit.location.row_start !== undefined;
    const paragraphs = rowUnit ? [unit.text] : unit.text.split(/\n\s*\n/);
    for (const raw of paragraphs) {
      const paragraph = raw.trim();
      if (!paragraph) continue;
      const pieces = paragraph.length > target ? splitLong(paragraph, target) : [paragraph];
      for (const piece of pieces) {
        if (buffer.length > 0 && buffer.length + piece.length + 2 > target) flush(!rowUnit);
        if (!bufFirst) bufFirst = unit.location;
        bufLast = unit.location;
        buffer += (buffer ? '\n\n' : '') + piece;
      }
    }
    if (rowUnit) flush(false);
  }
  flush(false);
  return { chunks, truncated };
}
