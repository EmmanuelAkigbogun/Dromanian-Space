// Numbered passages handed to the model, and validation of the [n] markers
// it writes back. Only numbers that came from a tool result in this run
// survive; anything else is removed rather than shown as a citation.

export interface Passage {
  n: number;
  chunkId: string;
  itemId: string;
  itemName: string;
  location: Record<string, unknown>;
  content: string;
}

export class CitationRegistry {
  private byChunk = new Map<string, Passage>();
  private byNumber = new Map<number, Passage>();

  add(p: Omit<Passage, 'n'>): Passage {
    const existing = this.byChunk.get(p.chunkId);
    if (existing) return existing;
    const passage: Passage = { ...p, n: this.byNumber.size + 1 };
    this.byChunk.set(p.chunkId, passage);
    this.byNumber.set(passage.n, passage);
    return passage;
  }

  get(n: number): Passage | undefined {
    return this.byNumber.get(n);
  }

  get size(): number {
    return this.byNumber.size;
  }
}

export function describeLocation(location: Record<string, unknown>): string {
  const page = location.page as number | undefined;
  const pageEnd = location.page_end as number | undefined;
  if (page !== undefined) return pageEnd && pageEnd !== page ? `pages ${page}–${pageEnd}` : `page ${page}`;
  const rowStart = location.row_start as number | undefined;
  const rowEnd = location.row_end as number | undefined;
  if (rowStart !== undefined) return `rows ${rowStart}–${rowEnd ?? rowStart}`;
  const section = location.section as string | undefined;
  if (section) return `section “${section}”`;
  return '';
}

export interface ResolvedCitation {
  ordinal: number;
  chunk_id: string;
  quote: string;
  itemId: string;
  itemName: string;
  location: Record<string, unknown>;
}

const MARKER = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g;

/** Keeps valid [n] markers, drops invented ones, and lists what was cited. */
export function resolveCitations(text: string, registry: CitationRegistry): { text: string; citations: ResolvedCitation[]; dropped: number } {
  const cited = new Map<number, ResolvedCitation>();
  let dropped = 0;
  const out = text.replace(MARKER, (_m, group: string) => {
    const valid: number[] = [];
    for (const raw of group.split(',')) {
      const n = Number(raw.trim());
      const passage = registry.get(n);
      if (!passage) {
        dropped++;
        continue;
      }
      valid.push(n);
      if (!cited.has(n)) {
        cited.set(n, {
          ordinal: n,
          chunk_id: passage.chunkId,
          quote: passage.content.slice(0, 300),
          itemId: passage.itemId,
          itemName: passage.itemName,
          location: passage.location,
        });
      }
    }
    return valid.length ? `[${valid.join(', ')}]` : '';
  });
  return { text: out, citations: [...cited.values()].sort((a, b) => a.ordinal - b.ordinal), dropped };
}

/** Footer for answers posted into a conversation, where the citation panel is not available. */
export function sourcesFooter(citations: ResolvedCitation[]): string {
  if (citations.length === 0) return '';
  const lines = citations.map((c) => {
    const where = describeLocation(c.location);
    return `[${c.ordinal}] [${c.itemName}${where ? `, ${where}` : ''}](/drive/item/${c.itemId})`;
  });
  return `\n\nSources:\n${lines.join('\n')}`;
}
