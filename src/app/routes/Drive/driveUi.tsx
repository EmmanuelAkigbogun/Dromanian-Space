// Drive building blocks: type icons, folder and file cards, the item menu
// (right-click or ⋮), and the Rename / Move dialogs.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from '@/components/ui/Dialog';
import { Floating } from '@/lib/overlay/Floating';
import { platform, result, errorText } from '@/features/platform/client';
import { fileTypeOf, folderTone, isImage, kindLabel, shortDate, type FileType, type Item } from './driveModel';
import s from '@/features/platform/Platform.module.css';
import d from './DrivePage.module.css';

const GLYPH: Record<FileType, ReactNode> = {
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />,
  document: <path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 15.5h6M9 9h2" />,
  pdf: <path d="M6 3h8l4 4v14H6zM14 3v4h4M8.5 16v-4h1.3a1.2 1.2 0 0 1 0 2.4H8.5M12.5 12v4h1a2 2 0 0 0 0-4zM16.5 16v-4h1.5M16.5 14h1.2" />,
  word: <path d="M6 3h8l4 4v14H6zM14 3v4h4M8.5 11l1.2 5 1.3-4 1.3 4 1.2-5" />,
  sheet: <path d="M6 3h8l4 4v14H6zM14 3v4h4M8.5 11h7v6h-7zM8.5 14h7M12 11v6" />,
  slides: <path d="M6 3h8l4 4v14H6zM14 3v4h4M8.5 11h7v4.5h-7zM12 15.5V18" />,
  image: <path d="M4 5h16v14H4zM4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 17M15.5 9.5h.01" />,
  video: <path d="M4 6h11v12H4zM15 10.5l5-3v9l-5-3" />,
  audio: <path d="M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 9 18zM19 16a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 19 16z" />,
  archive: <path d="M5 4h14v16H5zM11 4v2h2v2h-2v2h2v2h-2M10.5 14h3v3h-3z" />,
  text: <path d="M6 3h8l4 4v14H6zM14 3v4h4M9 11h6M9 14h6M9 17h4" />,
  other: <path d="M6 3h8l4 4v14H6zM14 3v4h4" />,
};

export function TypeIcon({ item, size = 'md' }: { item: { kind: string; name: string; mime_type?: string | null; id?: string }; size?: 'sm' | 'md' | 'lg' }) {
  const type = fileTypeOf(item);
  return (
    <span className={`${d.typeIcon} ${d[`size-${size}`]}`} data-type={type} data-tone={type === 'folder' && item.id ? folderTone(item.id) : undefined} aria-hidden="true">
      <svg viewBox="0 0 24 24">{GLYPH[type]}</svg>
    </span>
  );
}

/** Folder card, after the folder-card pattern: a tabbed folder shape that lifts on hover. */
export function FolderCard({ item, selected, dropTarget, onClick, onOpen, onMenu, dragProps }: {
  item: Item; selected: boolean; dropTarget: boolean;
  onClick: (e: React.MouseEvent) => void; onOpen: () => void; onMenu: (e: React.MouseEvent) => void;
  dragProps: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
}) {
  return (
    <div role="option" aria-selected={selected} tabIndex={-1} data-id={item.id}
      className={`${d.folderCard} ${selected ? d.isSelected : ''} ${dropTarget ? d.isDropTarget : ''}`}
      data-tone={folderTone(item.id)} onClick={onClick} onDoubleClick={onOpen} onContextMenu={onMenu} {...dragProps}>
      <span className={d.folderTab} aria-hidden="true" />
      <span className={d.folderBody}>
        <span className={d.folderPapers} aria-hidden="true"><i /><i /></span>
        <span className={d.folderFront}>
          <TypeIcon item={item} />
          <span className={d.folderText}>
            <strong title={item.name}>{item.name}</strong>
            <span>{dropTarget ? 'Drop to move here' : `${item.owner_name ?? 'Unknown'} · ${shortDate(item.updated_at)}`}</span>
          </span>
          {item.starred && <span className={d.star} aria-label="Starred">★</span>}
          <button type="button" className={d.kebab} aria-label={`More actions for ${item.name}`} onClick={(e) => { e.stopPropagation(); onMenu(e); }}>⋮</button>
        </span>
      </span>
    </div>
  );
}

export function FileCard({ item, selected, onClick, onOpen, onMenu, dragProps }: {
  item: Item; selected: boolean;
  onClick: (e: React.MouseEvent) => void; onOpen: () => void; onMenu: (e: React.MouseEvent) => void;
  dragProps: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
}) {
  return (
    <div role="option" aria-selected={selected} tabIndex={-1} data-id={item.id}
      className={`${d.fileCard} ${selected ? d.isSelected : ''}`} onClick={onClick} onDoubleClick={onOpen} onContextMenu={onMenu} {...dragProps}>
      <div className={d.fileCardHead}>
        <TypeIcon item={item} size="sm" />
        <strong title={item.name}>{item.name}</strong>
        <button type="button" className={d.kebab} aria-label={`More actions for ${item.name}`} onClick={(e) => { e.stopPropagation(); onMenu(e); }}>⋮</button>
      </div>
      <div className={d.thumb} data-type={fileTypeOf(item)}>
        {isImage(item) && item.current_version_id ? <Thumbnail item={item} /> : <TypeIcon item={item} size="lg" />}
      </div>
      <div className={d.fileCardFoot}>
        <span>{kindLabel(item)}</span>
        <span>{item.starred && <span className={d.star} aria-label="Starred">★ </span>}{shortDate(item.updated_at)}</span>
      </div>
    </div>
  );
}

function Thumbnail({ item }: { item: Item }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const url = useQuery({
    queryKey: ['platform', 'drive-thumb', item.current_version_id],
    enabled: visible && item.size_bytes < 15_000_000,
    staleTime: 240_000,
    queryFn: async () => {
      const v = await result(platform.from('drive_versions').select('storage_bucket,storage_path').eq('id', item.current_version_id).single());
      return (await result(platform.storage.from(v.storage_bucket).createSignedUrl(v.storage_path, 300))).signedUrl as string;
    },
  });
  return <span ref={ref} className={d.thumbImage}>{url.data ? <img src={url.data} alt="" loading="lazy" /> : <TypeIcon item={item} size="lg" />}</span>;
}

export interface MenuAction { label: string; icon?: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string; divider?: boolean }

/** A menu at the pointer (right-click) or under a ⋮ button. */
export function ItemMenu({ at, actions, onClose }: { at: { x: number; y: number }; actions: MenuAction[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x, innerWidth - width - 8)), y: Math.max(8, Math.min(at.y, innerHeight - height - 8)) });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [at]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', onClose);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', onClose); };
  }, [onClose]);
  return (
    <div ref={ref} className={d.menu} role="menu" style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000 }}>
      {actions.map((a, i) => (
        <div key={a.label + i}>
          {a.divider && <hr className={d.menuRule} />}
          <button type="button" role="menuitem" className={`${d.menuItem} ${a.danger ? d.menuDanger : ''}`} disabled={a.disabled} title={a.hint}
            onClick={() => { onClose(); a.onSelect(); }}>
            <span className={d.menuGlyph} aria-hidden="true">{a.icon}</span>{a.label}
          </button>
        </div>
      ))}
    </div>
  );
}

/** A filter chip with a dropdown, like Drive's Type / People / Modified. */
export function Chip({ label, active, children, onClear }: { label: string; active: boolean; children: (close: () => void) => ReactNode; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <span className={`${d.chip} ${active ? d.chipOn : ''}`}>
      <button ref={anchor} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}<span aria-hidden="true" className={d.caret}>▾</span>
      </button>
      {active && <button type="button" className={d.chipClear} aria-label={`Clear ${label} filter`} onClick={onClear}>×</button>}
      <Floating open={open} anchor={anchor} placement="bottom-start" offset={6} onDismiss={() => setOpen(false)} role="menu" className={d.menu}>
        {children(() => setOpen(false))}
      </Floating>
    </span>
  );
}

export function RenameDialog({ item, onClose, onDone }: { item: Item; onClose: () => void; onDone: () => Promise<unknown> }) {
  const [name, setName] = useState(item.name);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Select the name without its extension, like Drive.
    const dot = item.kind === 'file' ? item.name.lastIndexOf('.') : -1;
    requestAnimationFrame(() => input.current?.setSelectionRange(0, dot > 0 ? dot : item.name.length));
  }, [item]);
  return (
    <Dialog open onClose={onClose} title="Rename" size="sm">
      <form className={s.form} onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || name.trim() === item.name) { onClose(); return; }
        setBusy(true);
        result(platform.rpc('drive_rename', { p_item_id: item.id, p_name: name.trim() }))
          .then(onDone).then(onClose).catch((err) => setError(errorText(err))).finally(() => setBusy(false));
      }}>
        <input ref={input} autoFocus className={s.input} aria-label="New name" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} required />
        {error && <p role="alert" className={s.error}>{error}</p>}
        <div className={d.dialogActions}>
          <button type="button" className={s.button} onClick={onClose}>Cancel</button>
          <button className={s.primary} disabled={busy || !name.trim()}>OK</button>
        </div>
      </form>
    </Dialog>
  );
}

type Crumb = { id: string | null; name: string };

/** Pick a destination folder by browsing, then confirm after seeing who gains or loses access. */
export function MoveDialog({ ws, userId, items, startFolder, onClose, onDone }: {
  ws: string; userId: string; items: Item[]; startFolder: string | null; onClose: () => void; onDone: () => Promise<unknown>;
}) {
  const [path, setPath] = useState<Crumb[]>([{ id: null, name: 'My files' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ gains: unknown[]; losses: unknown[] } | null>(null);
  const here = path.at(-1)!;
  const moving = new Set(items.map((i) => i.id));
  useEffect(() => {
    if (!startFolder) return;
    result(platform.rpc('drive_breadcrumbs', { p_item_id: startFolder }))
      .then((cs) => setPath([{ id: null, name: 'My files' }, ...(cs as { id: string; name: string }[]).map((c) => ({ id: c.id, name: c.name }))]))
      .catch(() => {});
  }, [startFolder]);
  const folders = useQuery({
    queryKey: ['platform', ws, userId, 'drive-move-browse', here.id],
    queryFn: async () => (await result(platform.rpc('drive_list', { p_workspace_id: ws, p_view: here.id ? 'folder' : 'my', p_folder_id: here.id, p_sort: 'name', p_limit: 500 })))
      .filter((f) => f.kind === 'folder' && !moving.has(f.id)),
  });
  useEffect(() => { setPreview(null); setError(''); }, [here.id]);
  const sameParent = items.every((i) => (i.parent_id ?? null) === here.id);
  const check = async () => {
    setBusy(true);
    setError('');
    try {
      const all = await Promise.all(items.map((i) => result(platform.rpc('drive_preview_move', { p_item_id: i.id, p_new_parent_id: here.id }))));
      const merged = (all as { gains: unknown[]; losses: unknown[] }[]).reduce((a, p) => ({ gains: [...a.gains, ...p.gains], losses: [...a.losses, ...p.losses] }), { gains: [], losses: [] });
      if (!merged.gains.length && !merged.losses.length) await move();
      else setPreview(merged);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const move = async () => {
    setBusy(true);
    try {
      for (const i of items) await result(platform.rpc('drive_move', { p_item_id: i.id, p_new_parent_id: here.id }));
      await onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Move ${items.length === 1 ? `“${items[0].name}”` : `${items.length} items`}`} size="md">
      <div className={d.moveBox}>
        <nav className={d.moveCrumbs} aria-label="Destination">
          {path.map((c, i) => (
            <span key={c.id ?? 'root'}>
              {i > 0 && <span aria-hidden="true">›</span>}
              <button type="button" disabled={i === path.length - 1} onClick={() => setPath(path.slice(0, i + 1))}>{c.name}</button>
            </span>
          ))}
        </nav>
        <div className={d.moveList} role="listbox" aria-label="Folders">
          {folders.isPending && <p className={d.muted}>Loading folders…</p>}
          {folders.data?.map((f) => (
            <button key={f.id} type="button" className={d.moveRow} onClick={() => setPath([...path, { id: f.id, name: f.name }])}>
              <TypeIcon item={f} size="sm" /><span>{f.name}</span><span aria-hidden="true" className={d.muted}>›</span>
            </button>
          ))}
          {folders.data && !folders.data.length && <p className={d.muted}>No folders here. You can move into “{here.name}”.</p>}
        </div>
        {preview && (
          <div className={s.notice}>
            Moving into “{here.name}” changes access: {preview.gains.length} new {preview.gains.length === 1 ? 'grant' : 'grants'} from the folder,
            {' '}{preview.losses.length} inherited {preview.losses.length === 1 ? 'grant' : 'grants'} removed. People who lose access can no longer open {items.length === 1 ? 'it' : 'them'}.
          </div>
        )}
        {error && <p role="alert" className={s.error}>{error}</p>}
        <div className={d.dialogActions}>
          <button type="button" className={s.button} onClick={onClose}>Cancel</button>
          {preview
            ? <button type="button" className={s.primary} disabled={busy} onClick={() => void move()}>Move anyway</button>
            : <button type="button" className={s.primary} disabled={busy || sameParent} onClick={() => void check()}>{sameParent ? 'Already here' : `Move to “${here.name}”`}</button>}
        </div>
      </div>
    </Dialog>
  );
}

/** Download the current version of a file through a short-lived signed link. */
export async function downloadItem(item: Item) {
  const v = await result(platform.from('drive_versions').select('storage_bucket,storage_path').eq('id', item.current_version_id).single());
  const signed = await result(platform.storage.from(v.storage_bucket).createSignedUrl(v.storage_path, 60));
  const a = document.createElement('a');
  a.href = signed.signedUrl;
  a.download = item.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
