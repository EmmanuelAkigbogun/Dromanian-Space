// Drive list helpers: file types, sizes, dates and the Type / Modified / People filters.
import type { RpcRow } from '@/features/platform/client';

export type Item = RpcRow<'drive_list'>;

export type FileType = 'folder' | 'document' | 'pdf' | 'word' | 'sheet' | 'slides' | 'image' | 'video' | 'audio' | 'archive' | 'text' | 'other';

export const TYPE_LABELS: Record<FileType, string> = {
  folder: 'Folders', document: 'Documents', pdf: 'PDFs', word: 'Word', sheet: 'Spreadsheets', slides: 'Presentations',
  image: 'Images', video: 'Videos', audio: 'Audio', archive: 'Archives (zip)', text: 'Text & CSV', other: 'Other files',
};

const EXT: Record<string, FileType> = {
  pdf: 'pdf', doc: 'word', docx: 'word', odt: 'word', rtf: 'word',
  xls: 'sheet', xlsx: 'sheet', ods: 'sheet', csv: 'sheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image', heic: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
  txt: 'text', md: 'text', json: 'text', xml: 'text',
};

export function extensionOf(name: string) {
  const ext = name.split('.').pop();
  return ext && ext !== name ? ext.toLowerCase() : '';
}

export function fileTypeOf(item: { kind: string; name: string; mime_type?: string | null }): FileType {
  if (item.kind === 'folder') return 'folder';
  if (item.kind === 'document') return 'document';
  const byExt = EXT[extensionOf(item.name)];
  if (byExt) return byExt;
  const mime = item.mime_type ?? '';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/')) return 'text';
  return 'other';
}

/** A short type name for the list: "Folder", "PDF", "DOCX". */
export function kindLabel(item: Item) {
  if (item.kind === 'folder') return 'Folder';
  if (item.kind === 'document') return 'Document';
  return extensionOf(item.name).toUpperCase() || 'File';
}

export const isPdf = (item: Item) => fileTypeOf(item) === 'pdf';
export const isImage = (item: Item) => fileTypeOf(item) === 'image' && !/\.svg$/i.test(item.name);

export function formatSize(bytes: number | null) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${value >= 10 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}

/** "14:32" today, "Nov 12" this year, "12 Nov 2025" before. */
export function shortDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export type Modified = '' | 'today' | 'week' | 'month' | 'year';
export const MODIFIED_LABELS: Record<Exclude<Modified, ''>, string> = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', year: 'This year' };

export type People = '' | 'me' | 'others';

export interface Filters { types: FileType[]; modified: Modified; people: People }
export const NO_FILTERS: Filters = { types: [], modified: '', people: '' };

export function matches(item: Item, f: Filters, userId: string) {
  if (f.types.length && !f.types.includes(fileTypeOf(item))) return false;
  if (f.people === 'me' && item.owner_id !== userId) return false;
  if (f.people === 'others' && item.owner_id === userId) return false;
  if (f.modified) {
    const t = new Date(item.updated_at).getTime();
    const now = new Date();
    const start = f.modified === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      : f.modified === 'week' ? now.getTime() - 7 * 864e5
        : f.modified === 'month' ? now.getTime() - 30 * 864e5
          : new Date(now.getFullYear(), 0, 1).getTime();
    if (t < start) return false;
  }
  return true;
}

export const canEdit = (item: Item) => item.my_role === 'owner' || item.my_role === 'editor';

const TONES = ['sky', 'teal', 'violet', 'amber', 'rose', 'emerald', 'orange', 'fuchsia'] as const;
/** A stable colour for a folder, from its id. */
export const folderTone = (id: string) => TONES[[...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % TONES.length];
