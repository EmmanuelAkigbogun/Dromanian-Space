// RFC 4180 CSV parsing with delimiter detection. Shared by indexing and the
// Data Assistant's metrics tool.

export interface ParsedCsv {
  delimiter: string;
  header: string[];
  rows: string[][];
  /** True when parsing stopped at maxRows. */
  truncated: boolean;
}

export function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === c && !quoted) count++;
    }
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(text: string, maxRows = 1_000_000): ParsedCsv {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(input.slice(0, 4096));
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  let truncated = false;
  let i = 0;
  const n = input.length;

  const endRecord = () => {
    record.push(field);
    field = '';
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
  };

  while (i < n) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      record.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      endRecord();
      if (ch === '\r' && input[i + 1] === '\n') i++;
      i++;
      if (records.length > maxRows) {
        truncated = true;
        break;
      }
    } else {
      field += ch;
      i++;
    }
  }
  if (!truncated && (field !== '' || record.length > 0)) endRecord();

  const header = (records.shift() ?? []).map((h, idx) => h.trim() || `column_${idx + 1}`);
  const rows = truncated ? records.slice(0, maxRows) : records;
  return { delimiter, header, rows, truncated };
}

export function csvLine(values: string[], delimiter = ','): string {
  return values
    .map((v) => (/[",\r\n;\t|]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
    .join(delimiter);
}
