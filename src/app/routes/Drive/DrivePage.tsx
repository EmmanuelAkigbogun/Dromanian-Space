// Drive, laid out like Google Drive: a "New" menu, filter chips, folders as
// cards above files, list or grid, right-click and ⋮ menus, drag to move,
// keyboard shortcuts, a details panel and an upload tray.
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { useAuth } from '@/hooks/useAuth';
import { Dialog } from '@/components/ui/Dialog';
import { DriveShareDialog } from '@/components/drive/DriveShareDialog';
import { Floating } from '@/lib/overlay/Floating';
import { platform, result, api, errorText } from '@/features/platform/client';
import { DriveItem } from './DriveItem';
import { isOfficeFile } from '@/components/drive/OfficeEditor';
import {
  MODIFIED_LABELS, NO_FILTERS, TYPE_LABELS, canEdit, fileTypeOf, formatSize, isPdf, kindLabel, matches, shortDate,
  type FileType, type Filters, type Item, type Modified,
} from './driveModel';
import { Chip, FileCard, FolderCard, ItemMenu, MoveDialog, RenameDialog, TypeIcon, downloadItem, type MenuAction } from './driveUi';
import s from '@/features/platform/Platform.module.css';
import d from './DrivePage.module.css';

type CreateKind = 'folder' | 'document' | 'docx' | 'xlsx' | 'pptx';
type DriveView = (typeof driveViews)[number][0] | 'folder';
const CREATE_LABELS: Record<CreateKind, string> = { folder: 'folder', document: 'document', docx: 'Word document', xlsx: 'Excel spreadsheet', pptx: 'PowerPoint presentation' };
export const driveViews = [['workspace', 'Workspace files'], ['my', 'My files'], ['shared', 'Shared with me'], ['recent', 'Recent'], ['starred', 'Starred'], ['trash', 'Trash']] as const;
const PAGE = 200;
const DRAG_TYPE = 'application/x-drive-items';

const EMPTY_COPY: Record<string, { title: string; body: string }> = {
  workspace: { title: 'No workspace files', body: 'Files appear here after someone shares them with the workspace.' },
  shared: { title: 'Nothing shared with you', body: 'Files and folders shared directly with you will appear here.' },
  recent: { title: 'No recent files', body: 'Files you open or update will appear here.' },
  starred: { title: 'No starred files', body: 'Star important files so they are easy to find.' },
  trash: { title: 'Trash is empty', body: 'Items you move to Trash stay here until they are deleted forever.' },
  my: { title: 'Drop files here', body: 'Or use the New button to create a folder, a document or upload files.' },
  folder: { title: 'Drop files here', body: 'Or use the New button to add something to this folder.' },
};

const readLayout = () => { try { return localStorage.getItem('drive.layout') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } };

export default function DrivePage() {
  const { currentWorkspace } = useWorkspaceContext();
  const { userId } = useAuth();
  const { itemId, folderId } = useParams();
  const [params] = useSearchParams();
  const ws = currentWorkspace!.id;
  return <DriveBrowser key={`${ws}:${userId}:${itemId ?? folderId ?? params.get('view') ?? 'my'}`} workspaceId={ws} userId={userId!} itemId={itemId} folderId={folderId} />;
}

function DriveBrowser({ workspaceId: ws, userId, itemId, folderId }: { workspaceId: string; userId: string; itemId?: string; folderId?: string }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const requested = params.get('view');
  const view: DriveView = folderId ? 'folder' : driveViews.some(([id]) => id === requested) ? (requested as Exclude<DriveView, 'folder'>) : 'my';

  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim());
  const [sort, setSort] = useState<'name' | 'updated' | 'size'>(view === 'recent' ? 'updated' : 'name');
  const [desc, setDesc] = useState(view === 'recent');
  const [page, setPage] = useState(0);
  const [layout, setLayoutState] = useState<'grid' | 'list'>(readLayout);
  const setLayout = (l: 'grid' | 'list') => { setLayoutState(l); try { localStorage.setItem('drive.layout', l); } catch { /* per-viewer only */ } };
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const [create, setCreate] = useState<CreateKind | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const newButton = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState<Item | null>(null);
  const [moving, setMoving] = useState<Item[] | null>(null);
  const [sharing, setSharing] = useState<Item | null>(null);
  const [details, setDetails] = useState(false);
  const [toast, setToast] = useState<{ text: string; undo?: () => Promise<unknown> } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const dragDepth = useRef(0);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<Array<{ name: string; progress: number; error?: string; file: File }>>([]);
  const [trayOpen, setTrayOpen] = useState(true);
  const abort = useRef<XMLHttpRequest | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; abort.current?.abort(); }; }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 7000); return () => clearTimeout(t); }, [toast]);

  const office = useQuery({ queryKey: ['platform', 'office-status'], staleTime: 300000, retry: false, queryFn: async () => (await (await api('office/status')).json()) as { enabled: boolean } });
  const files = useQuery({
    queryKey: ['platform', ws, userId, 'drive', view, folderId, query, sort, desc, page],
    queryFn: () => result(platform.rpc('drive_list', {
      p_workspace_id: ws, p_view: query ? 'search' : view, p_folder_id: folderId ?? null, p_search: query, p_sort: sort, p_desc: desc,
      p_limit: PAGE, p_offset: page * PAGE, p_channel_id: params.get('channel'),
    })),
    staleTime: 10000,
    refetchInterval: 30000,
    placeholderData: (prev) => prev,
  });
  const crumbs = useQuery({ queryKey: ['platform', ws, userId, 'breadcrumbs', folderId], enabled: !!folderId, queryFn: () => result(platform.rpc('drive_breadcrumbs', { p_item_id: folderId! })) });
  const currentFolder = useQuery({
    queryKey: ['platform', ws, userId, 'drive-folder', folderId], enabled: !!folderId,
    queryFn: () => result(platform.from('drive_items').select('*').eq('workspace_id', ws).eq('id', folderId!).maybeSingle()),
  });

  const all = useMemo(() => (files.data ?? []).filter((i) => matches(i, filters, userId)), [files.data, filters, userId]);
  const folders = all.filter((i) => i.kind === 'folder');
  const others = all.filter((i) => i.kind !== 'folder');
  const ordered = useMemo(() => [...folders, ...others], [folders, others]);
  const selectedItems = ordered.filter((i) => selected.has(i.id));
  const totalCount = files.data?.[0]?.total_count ?? 0;
  const filtering = filters.types.length > 0 || !!filters.modified || !!filters.people;
  useEffect(() => { setSelected(new Set()); }, [view, folderId, query, sort, desc, page, filters]);

  const refresh = useCallback(() => cache.invalidateQueries({ queryKey: ['platform', ws, userId] }), [cache, ws, userId]);
  const viewTitle = folderId ? crumbs.data?.at(-1)?.name ?? currentFolder.data?.name ?? 'Folder' : driveViews.find(([id]) => id === view)?.[1] ?? 'Drive';
  /** Where opening an item goes: folders open, Office files and PDFs open in the editor, everything else in the viewer. */
  const opensInEditor = (i: Item) => i.kind === 'file' && (isPdf(i) || (!!office.data?.enabled && isOfficeFile(i.name)));
  const itemLink = (i: Item) => `/drive/${i.kind === 'folder' ? 'folder' : 'item'}/${i.id}${opensInEditor(i) ? '?edit=1' : ''}`;
  const open = (i: Item) => navigate(itemLink(i));

  async function run(label: string, ops: Array<() => PromiseLike<unknown>>, undo?: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    const outcomes = await Promise.allSettled(ops.map((op) => op()));
    const failed = outcomes.filter((o) => o.status === 'rejected');
    await refresh();
    setBusy(false);
    if (failed.length) setError(failed.length === outcomes.length ? errorText((failed[0] as PromiseRejectedResult).reason) : `${failed.length} of ${outcomes.length} items could not be changed. Your access may have changed.`);
    else { setSelected(new Set()); setToast({ text: label, undo }); }
  }
  const trash = (items: Item[]) => {
    const editable = items.filter(canEdit);
    if (!editable.length) { setError('You can only move to Trash items you own or can edit.'); return; }
    void run(`${editable.length === 1 ? `“${editable[0].name}”` : `${editable.length} items`} moved to Trash`,
      editable.map((i) => () => result(platform.rpc('drive_trash', { p_item_id: i.id }))),
      () => Promise.all(editable.map((i) => result(platform.rpc('drive_restore', { p_item_id: i.id })))).then(refresh));
  };
  const restore = (items: Item[]) => void run(`${items.length === 1 ? `“${items[0].name}”` : `${items.length} items`} restored`, items.map((i) => () => result(platform.rpc('drive_restore', { p_item_id: i.id }))));
  const deleteForever = (items: Item[]) => {
    if (!window.confirm(`Delete ${items.length === 1 ? `“${items[0].name}”` : `${items.length} items`} forever? This can't be undone.`)) return;
    void run(`${items.length === 1 ? 'Item' : `${items.length} items`} deleted forever`, items.map((i) => () => result(platform.rpc('drive_delete_forever', { p_item_id: i.id }))));
  };
  const star = (items: Item[]) => {
    const on = !items.every((i) => i.starred);
    void run(on ? 'Added to Starred' : 'Removed from Starred', items.filter((i) => i.starred !== on).map((i) => () => result(platform.rpc('drive_toggle_star', { p_item_id: i.id }))));
  };
  const download = (items: Item[]) => {
    const fileItems = items.filter((i) => i.kind === 'file' && i.current_version_id);
    if (!fileItems.length) { setError('Folders and documents can’t be downloaded yet. Open a document to copy its text.'); return; }
    fileItems.forEach((i, n) => setTimeout(() => { downloadItem(i).catch((e) => setError(errorText(e))); }, n * 400));
  };

  /** Move by drag and drop; asks first when the move changes who can open the items. */
  async function moveTo(ids: string[], target: string | null, targetName: string) {
    const items = (files.data ?? []).filter((i) => ids.includes(i.id) && i.id !== target && (i.parent_id ?? null) !== target);
    if (!items.length) return;
    try {
      const previews = await Promise.all(items.map((i) => result(platform.rpc('drive_preview_move', { p_item_id: i.id, p_new_parent_id: target })) as Promise<{ gains: unknown[]; losses: unknown[] }>));
      const gains = previews.reduce((n, p) => n + p.gains.length, 0);
      const losses = previews.reduce((n, p) => n + p.losses.length, 0);
      if ((gains || losses) && !window.confirm(`Moving into “${targetName}” changes who can open ${items.length === 1 ? 'this item' : 'these items'} (${gains} added, ${losses} removed). Move anyway?`)) return;
    } catch (e) { setError(errorText(e)); return; }
    const back = items.map((i) => [i.id, i.parent_id ?? null] as const);
    void run(`${items.length === 1 ? `“${items[0].name}”` : `${items.length} items`} moved to “${targetName}”`,
      items.map((i) => () => result(platform.rpc('drive_move', { p_item_id: i.id, p_new_parent_id: target }))),
      () => Promise.all(back.map(([id, parent]) => result(platform.rpc('drive_move', { p_item_id: id, p_new_parent_id: parent })))).then(refresh));
  }

  // ── Selection ──
  const click = (item: Item, e: React.MouseEvent) => {
    // Touch screens have no double-click: a tap opens, like the Drive app.
    if ((e.nativeEvent as PointerEvent).pointerType === 'touch' && !selected.size) { open(item); return; }
    if (e.shiftKey && anchor.current) {
      const a = ordered.findIndex((i) => i.id === anchor.current);
      const b = ordered.findIndex((i) => i.id === item.id);
      const range = ordered.slice(Math.min(a, b), Math.max(a, b) + 1).map((i) => i.id);
      setSelected(new Set(e.ctrlKey || e.metaKey ? [...selected, ...range] : range));
      return;
    }
    anchor.current = item.id;
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
      setSelected(next);
    } else setSelected(new Set([item.id]));
  };
  const openMenu = (item: Item, e: React.MouseEvent) => {
    e.preventDefault();
    const ids = selected.has(item.id) ? [...selected] : [item.id];
    if (!selected.has(item.id)) { setSelected(new Set([item.id])); anchor.current = item.id; }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: e.type === 'contextmenu' ? e.clientX : r.right - 200, y: e.type === 'contextmenu' ? e.clientY : r.bottom + 4, ids });
  };

  const actionsFor = (ids: string[]): MenuAction[] => {
    const items = ordered.filter((i) => ids.includes(i.id));
    if (!items.length) return [];
    const one = items.length === 1 ? items[0] : null;
    if (view === 'trash') {
      return [
        { label: 'Restore', icon: '↺', onSelect: () => restore(items) },
        { label: 'Delete forever', icon: '✕', danger: true, onSelect: () => deleteForever(items) },
      ];
    }
    const editable = items.every(canEdit);
    return [
      ...(one ? [{ label: one.kind === 'folder' ? 'Open' : opensInEditor(one) ? (isPdf(one) ? 'Open PDF' : 'Open in editor') : 'Open', icon: '↗', onSelect: () => open(one) }] : []),
      ...(items.some((i) => i.kind === 'file') ? [{ label: 'Download', icon: '⤓', onSelect: () => download(items) }] : []),
      ...(one ? [{ label: 'Rename', icon: '✎', disabled: !canEdit(one), hint: canEdit(one) ? 'F2' : 'You need edit access', onSelect: () => setRenaming(one) }] : []),
      ...(one ? [{ label: 'Share', icon: '⇪', divider: true, onSelect: () => setSharing(one) }] : []),
      { label: 'Move to…', icon: '→', divider: !one, disabled: !editable, hint: editable ? undefined : 'You need edit access', onSelect: () => setMoving(items) },
      { label: items.every((i) => i.starred) ? 'Remove from Starred' : 'Add to Starred', icon: '★', onSelect: () => star(items) },
      { label: 'Details', icon: 'ⓘ', onSelect: () => { setSelected(new Set(ids)); setDetails(true); } },
      { label: 'Move to Trash', icon: '🗑', danger: true, divider: true, disabled: !items.some(canEdit), hint: 'Delete', onSelect: () => trash(items) },
    ];
  };

  // ── Keyboard: Enter, Delete, F2, Ctrl+A, Esc, arrows ──
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (menu || create || renaming || moving || sharing) return;
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
      const sel = ordered.filter((i) => selected.has(i.id));
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelected(new Set(ordered.map((i) => i.id))); return; }
      if (e.key === 'Escape') { setSelected(new Set()); return; }
      if (!sel.length) return;
      if (e.key === 'Enter' && sel.length === 1) { e.preventDefault(); open(sel[0]); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && view !== 'trash') { e.preventDefault(); trash(sel); }
      else if (e.key === 'F2' && sel.length === 1 && canEdit(sel[0]) && view !== 'trash') { e.preventDefault(); setRenaming(sel[0]); }
      else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const i = ordered.findIndex((x) => x.id === (anchor.current ?? sel[0].id));
        const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
        const next = ordered[Math.max(0, Math.min(ordered.length - 1, i + step))];
        anchor.current = next.id;
        setSelected(new Set([next.id]));
        document.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // ── Drag: items onto folders (move), files from the computer (upload) ──
  const dragProps = (item: Item) => {
    const movable = view !== 'trash' && canEdit(item);
    const isFolder = item.kind === 'folder' && view !== 'trash';
    return {
      draggable: movable,
      onDragStart: (e: React.DragEvent) => {
        const ids = selected.has(item.id) ? [...selected] : [item.id];
        if (!selected.has(item.id)) setSelected(new Set([item.id]));
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => setDropFolder(null),
      ...(isFolder ? {
        onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(DRAG_TYPE) && !selected.has(item.id)) { e.preventDefault(); e.stopPropagation(); setDropFolder(item.id); } },
        onDragLeave: () => setDropFolder((f) => (f === item.id ? null : f)),
        onDrop: (e: React.DragEvent) => {
          const raw = e.dataTransfer.getData(DRAG_TYPE);
          if (!raw) return;
          e.preventDefault();
          e.stopPropagation();
          setDropFolder(null);
          void moveTo(JSON.parse(raw) as string[], item.id, item.name);
        },
      } : {}),
    };
  };
  const crumbDrop = (target: string | null, name: string) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setDropFolder(`crumb:${target}`); } },
    onDragLeave: () => setDropFolder(null),
    onDrop: (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      setDropFolder(null);
      if (raw) { e.preventDefault(); void moveTo(JSON.parse(raw) as string[], target, name); }
    },
    className: dropFolder === `crumb:${target}` ? d.crumbDrop : undefined,
  });

  // ── Create and upload ──
  const [newName, setNewName] = useState('');
  async function createItem(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (create === 'docx' || create === 'xlsx' || create === 'pptx') {
        const created = await (await api('drive/new-office', { workspace_id: ws, parent_id: folderId ?? null, kind: create, name: newName })).json() as { item_id: string };
        await refresh();
        setCreate(null);
        navigate(`/drive/item/${created.item_id}${office.data?.enabled ? '?edit=1' : ''}`);
        return;
      }
      const item = create === 'folder'
        ? await result(platform.rpc('drive_create_folder', { p_workspace_id: ws, p_parent_id: folderId ?? null, p_name: newName }))
        : await result(platform.rpc('drive_create_document', { p_workspace_id: ws, p_parent_id: folderId ?? null, p_title: newName, p_body: '' }));
      await refresh();
      setCreate(null);
      if (item.kind === 'folder') setToast({ text: `Folder “${item.name}” created` });
      else navigate(`/drive/item/${item.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  const startCreate = (k: CreateKind) => { setNewMenu(false); setNewName(k === 'folder' ? 'Untitled folder' : ''); setCreate(k); };

  async function upload(file: File) {
    if (file.size > 50 * 1024 * 1024) throw new Error('Files must be 50 MB or smaller.');
    const ticket = await result(platform.rpc('drive_begin_upload', { p_workspace_id: ws, p_parent_id: folderId ?? null, p_name: file.name, p_mime_type: file.type || 'application/octet-stream', p_size_bytes: file.size })) as { version_id: string; bucket: string; path: string };
    try {
      const { data: { session } } = await platform.auth.getSession();
      if (!session) throw new Error('Please sign in again.');
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        abort.current = xhr;
        xhr.open('POST', `/api/storage/object/${encodeURIComponent(ticket.bucket)}/${ticket.path.split('/').map(encodeURIComponent).join('/')}`);
        xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.upload.onprogress = (e) => { if (e.lengthComputable && alive.current) setUploads((u) => u.map((x) => (x.file === file ? { ...x, progress: Math.round((e.loaded / e.total) * 95) } : x))); };
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error('Upload failed. Retry when your connection is available.')));
        xhr.onerror = () => reject(new Error('Upload connection failed.'));
        xhr.onabort = () => reject(new Error('Upload cancelled.'));
        xhr.send(file);
      });
      await result(platform.rpc('drive_finalize_upload', { p_version_id: ticket.version_id }));
      if (alive.current) setUploads((u) => u.map((x) => (x.file === file ? { ...x, progress: 100, error: undefined } : x)));
    } catch (e) {
      await platform.rpc('drive_cancel_upload', { p_version_id: ticket.version_id });
      throw e;
    }
  }
  async function uploadFiles(list: File[]) {
    setBusy(true);
    setError('');
    setTrayOpen(true);
    setUploads(list.map((file) => ({ name: file.name, file, progress: 0 })));
    for (const file of list) {
      if (!alive.current) break;
      try { await upload(file); } catch (e) { if (alive.current) setUploads((u) => u.map((x) => (x.file === file ? { ...x, error: errorText(e) } : x))); }
    }
    if (!alive.current) return;
    setBusy(false);
    await refresh();
    if (!folderId && view !== 'my') navigate('/drive?view=my');
    void api('jobs/run', { workspace_id: ws }).catch(() => setError('Upload saved. Indexing will start when the background worker is available.'));
  }
  const pageDrag = {
    onDragEnter: (e: React.DragEvent) => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); dragDepth.current += 1; setFileDrag(true); },
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); },
    onDragLeave: (e: React.DragEvent) => { if (!e.dataTransfer.types.includes('Files')) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setFileDrag(false); },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      dragDepth.current = 0;
      setFileDrag(false);
      const dropped = [...e.dataTransfer.files];
      if (view === 'trash') { setError('Open My files or a folder to upload.'); return; }
      if (!busy && dropped.length) void uploadFiles(dropped);
    },
  };

  if (itemId) return <DriveItem key={itemId} itemId={itemId} workspaceId={ws} userId={userId} />;

  const empty = EMPTY_COPY[view] ?? EMPTY_COPY.my;
  const focused = selectedItems.length === 1 ? selectedItems[0] : null;
  const canUpload = view !== 'trash' && view !== 'shared' && view !== 'starred' && view !== 'recent';
  const sortLabel = sort === 'name' ? 'Name' : sort === 'updated' ? 'Last modified' : 'File size';
  const sortBy = (k: 'name' | 'updated' | 'size') => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(k !== 'name'); } setPage(0); };
  const typeOptions = (Object.keys(TYPE_LABELS) as FileType[]).filter((t) => (t !== 'video' && t !== 'audio') || (files.data ?? []).some((i) => fileTypeOf(i) === t));

  return (
    <div className={`${s.page} ${d.drivePage}`} {...pageDrag} onClick={(e) => { if (e.target === e.currentTarget) setSelected(new Set()); }}>
      {/* ── Header ── */}
      <header className={d.header}>
        <div className={d.headerLeft}>
          <div className={d.newWrap}>
            <button ref={newButton} type="button" className={d.newButton} aria-haspopup="menu" aria-expanded={newMenu} onClick={() => setNewMenu(!newMenu)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>New
            </button>
            <Floating open={newMenu} anchor={newButton} placement="bottom-start" offset={6} onDismiss={() => setNewMenu(false)} role="menu" className={d.menu}>
              <button type="button" role="menuitem" className={d.menuItem} onClick={() => startCreate('folder')}><TypeIcon item={{ kind: 'folder', name: '', mime_type: '' }} size="sm" />New folder</button>
              <hr className={d.menuRule} />
              <button type="button" role="menuitem" className={d.menuItem} onClick={() => { setNewMenu(false); uploadInput.current?.click(); }}><span className={d.menuGlyph}>⤒</span>File upload</button>
              <hr className={d.menuRule} />
              <button type="button" role="menuitem" className={d.menuItem} onClick={() => startCreate('document')}><TypeIcon item={{ kind: 'document', name: '', mime_type: '' }} size="sm" />Document</button>
              <button type="button" role="menuitem" className={d.menuItem} onClick={() => startCreate('docx')}><TypeIcon item={{ kind: 'file', name: 'a.docx', mime_type: '' }} size="sm" />Word document</button>
              <button type="button" role="menuitem" className={d.menuItem} onClick={() => startCreate('xlsx')}><TypeIcon item={{ kind: 'file', name: 'a.xlsx', mime_type: '' }} size="sm" />Excel spreadsheet</button>
              <button type="button" role="menuitem" className={d.menuItem} onClick={() => startCreate('pptx')}><TypeIcon item={{ kind: 'file', name: 'a.pptx', mime_type: '' }} size="sm" />PowerPoint presentation</button>
            </Floating>
            <input ref={uploadInput} className={s.fileInput} aria-label="Upload files from computer" type="file" multiple disabled={busy}
              onChange={(e) => { const picked = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ''; if (picked.length) void uploadFiles(picked); }} />
          </div>
          <label className={d.search}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></svg>
            <span className={d.srOnly}>Search in Drive</span>
            <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder="Search in Drive" />
            {search && <button type="button" aria-label="Clear search" onClick={() => setSearch('')}>×</button>}
          </label>
        </div>
      </header>

      <nav className={d.mobileViews} aria-label="Drive views">
        {driveViews.map(([id, label]) => <Link key={id} className={view === id ? d.mobileViewOn : undefined} to={`/drive?view=${id}`}>{label}</Link>)}
      </nav>

      {/* ── Title / breadcrumbs ── */}
      <div className={d.titleRow}>
        <nav className={d.crumbs} aria-label="Location">
          {query ? <h1>Search results for “{query}”</h1> : folderId ? (
            <>
              <Link to="/drive?view=my" {...crumbDrop(null, 'My files')}>My files</Link>
              {crumbs.data?.slice(0, -1).map((c) => (
                <span key={c.id} className={d.crumbPart}><span aria-hidden="true">›</span><Link to={`/drive/folder/${c.id}`} {...crumbDrop(c.id, c.name)}>{c.name}</Link></span>
              ))}
              <span className={d.crumbPart}><span aria-hidden="true">›</span><FolderTitleMenu title={viewTitle}
                actions={currentFolder.data ? [
                  { label: 'New folder', icon: '＋', onSelect: () => startCreate('folder') },
                  { label: 'Upload files', icon: '⤒', onSelect: () => uploadInput.current?.click() },
                  { label: 'Rename', icon: '✎', divider: true, onSelect: () => setRenaming({ ...(currentFolder.data as unknown as Item), my_role: 'editor' }) },
                  { label: 'Share', icon: '⇪', onSelect: () => setSharing(currentFolder.data as unknown as Item) },
                  { label: 'Details', icon: 'ⓘ', onSelect: () => { setSelected(new Set()); setDetails(true); } },
                ] : []} /></span>
            </>
          ) : <h1>{viewTitle}</h1>}
        </nav>
        <div className={d.titleTools}>
          {view === 'trash' && !!files.data?.length && (
            <button type="button" className={d.textButton} onClick={() => deleteForever(files.data ?? [])}>Empty trash</button>
          )}
          <div className={d.segmented} role="group" aria-label="Layout">
            <button type="button" aria-pressed={layout === 'list'} aria-label="List layout" onClick={() => setLayout('list')}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <button type="button" aria-pressed={layout === 'grid'} aria-label="Grid layout" onClick={() => setLayout('grid')}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /></svg>
            </button>
          </div>
          <button type="button" className={`${d.iconButton} ${details ? d.iconButtonOn : ''}`} aria-pressed={details} aria-label="View details" title="View details" onClick={() => setDetails(!details)}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5h.01" /></svg>
          </button>
        </div>
      </div>

      {/* ── Filter chips, or the selection toolbar ── */}
      {selectedItems.length > 0 ? (
        <div className={d.selectionBar} role="toolbar" aria-label="Selected items">
          <button type="button" className={d.iconButton} aria-label="Clear selection" onClick={() => setSelected(new Set())}>×</button>
          <strong>{selectedItems.length} selected</strong>
          <span className={d.barDivider} />
          {view === 'trash' ? (
            <>
              <button type="button" className={d.barButton} disabled={busy} onClick={() => restore(selectedItems)}>↺ Restore</button>
              <button type="button" className={`${d.barButton} ${d.danger}`} disabled={busy} onClick={() => deleteForever(selectedItems)}>Delete forever</button>
            </>
          ) : (
            <>
              {focused && <button type="button" className={d.barButton} onClick={() => setSharing(focused)}>⇪ Share</button>}
              {selectedItems.some((i) => i.kind === 'file') && <button type="button" className={d.barButton} onClick={() => download(selectedItems)}>⤓ Download</button>}
              <button type="button" className={d.barButton} disabled={busy || !selectedItems.every(canEdit)} onClick={() => setMoving(selectedItems)}>→ Move</button>
              <button type="button" className={d.barButton} disabled={busy || !selectedItems.some(canEdit)} onClick={() => trash(selectedItems)}>🗑 Trash</button>
              <button type="button" className={d.barButton} disabled={busy} onClick={() => star(selectedItems)}>{selectedItems.every((i) => i.starred) ? '☆ Unstar' : '★ Star'}</button>
              <button type="button" className={d.iconButton} aria-label="More actions" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4, ids: selectedItems.map((i) => i.id) }); }}>⋮</button>
            </>
          )}
        </div>
      ) : (
        <div className={d.chips}>
          <Chip label={filters.types.length ? (filters.types.length === 1 ? TYPE_LABELS[filters.types[0]] : `${filters.types.length} types`) : 'Type'} active={filters.types.length > 0} onClear={() => setFilters({ ...filters, types: [] })}>
            {() => typeOptions.map((t) => (
              <label key={t} className={d.menuCheck}>
                <input type="checkbox" checked={filters.types.includes(t)} onChange={() => setFilters({ ...filters, types: filters.types.includes(t) ? filters.types.filter((x) => x !== t) : [...filters.types, t] })} />
                <TypeIcon item={{ kind: t === 'folder' ? 'folder' : t === 'document' ? 'document' : 'file', name: `x.${{ pdf: 'pdf', word: 'docx', sheet: 'xlsx', slides: 'pptx', image: 'png', video: 'mp4', audio: 'mp3', archive: 'zip', text: 'txt' }[t as string] ?? 'bin'}`, mime_type: '' }} size="sm" />
                {TYPE_LABELS[t]}
              </label>
            ))}
          </Chip>
          <Chip label={filters.people === 'me' ? 'Owned by me' : filters.people === 'others' ? 'Not owned by me' : 'People'} active={!!filters.people} onClear={() => setFilters({ ...filters, people: '' })}>
            {(close) => (['me', 'others'] as const).map((p) => (
              <button key={p} type="button" role="menuitemradio" aria-checked={filters.people === p} className={d.menuItem} onClick={() => { setFilters({ ...filters, people: p }); close(); }}>
                <span className={d.menuGlyph}>{filters.people === p ? '✓' : ''}</span>{p === 'me' ? 'Owned by me' : 'Not owned by me'}
              </button>
            ))}
          </Chip>
          <Chip label={filters.modified ? MODIFIED_LABELS[filters.modified] : 'Modified'} active={!!filters.modified} onClear={() => setFilters({ ...filters, modified: '' })}>
            {(close) => (Object.keys(MODIFIED_LABELS) as Exclude<Modified, ''>[]).map((m) => (
              <button key={m} type="button" role="menuitemradio" aria-checked={filters.modified === m} className={d.menuItem} onClick={() => { setFilters({ ...filters, modified: m }); close(); }}>
                <span className={d.menuGlyph}>{filters.modified === m ? '✓' : ''}</span>{MODIFIED_LABELS[m]}
              </button>
            ))}
          </Chip>
          {filtering && <button type="button" className={d.textButton} onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
          <span className={d.spacer} />
          {layout === 'grid' && (
            <button type="button" className={d.sortButton} onClick={() => sortBy(sort)} title="Change sort direction" aria-label={`Sorted by ${sortLabel}, ${desc ? 'descending' : 'ascending'}. Reverse`}>
              <span aria-hidden="true">{desc ? '↓' : '↑'}</span>
            </button>
          )}
          {layout === 'grid' && (
            <select className={d.sortSelect} aria-label="Sort by" value={sort} onChange={(e) => { setSort(e.target.value as typeof sort); setDesc(e.target.value !== 'name'); setPage(0); }}>
              <option value="name">Name</option>
              <option value="updated">Last modified</option>
              <option value="size">File size</option>
            </select>
          )}
        </div>
      )}

      {(error || files.error) && <div role="alert" className={s.error}>{error || errorText(files.error)} <button type="button" className={d.textButton} onClick={() => setError('')}>Dismiss</button></div>}

      {/* ── Content ── */}
      <div className={`${d.body} ${details ? d.withDetails : ''}`}>
        <main className={d.content} onClick={(e) => { if (e.target === e.currentTarget) setSelected(new Set()); }} aria-busy={files.isFetching}>
          {files.isPending ? (
            <div className={d.skeletonGrid} role="status" aria-label="Loading files">{Array.from({ length: 8 }, (_, i) => <span key={i} />)}</div>
          ) : !all.length ? (
            <div className={d.empty}>
              <div className={d.emptyArt} aria-hidden="true"><span /><span /><span /></div>
              <h2>{query || filtering ? 'No matching files' : empty.title}</h2>
              <p>{query || filtering ? 'Try another name, or clear the filters.' : empty.body}</p>
              {!query && !filtering && canUpload && <button className={s.primary} type="button" disabled={busy} onClick={() => uploadInput.current?.click()}>Upload files</button>}
              {filtering && <button className={s.button} type="button" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
            </div>
          ) : layout === 'grid' ? (
            <div role="listbox" aria-multiselectable="true" aria-label={viewTitle}>
              {folders.length > 0 && (
                <section className={d.section}>
                  <h2 className={d.sectionTitle}>Folders</h2>
                  <div className={d.folderGrid}>
                    {folders.map((f) => (
                      <FolderCard key={f.id} item={f} selected={selected.has(f.id)} dropTarget={dropFolder === f.id}
                        onClick={(e) => click(f, e)} onOpen={() => open(f)} onMenu={(e) => openMenu(f, e)} dragProps={dragProps(f)} />
                    ))}
                  </div>
                </section>
              )}
              {others.length > 0 && (
                <section className={d.section}>
                  <h2 className={d.sectionTitle}>Files</h2>
                  <div className={d.fileGrid}>
                    {others.map((f) => (
                      <FileCard key={f.id} item={f} selected={selected.has(f.id)}
                        onClick={(e) => click(f, e)} onOpen={() => open(f)} onMenu={(e) => openMenu(f, e)} dragProps={dragProps(f)} />
                    ))}
                  </div>
                </section>
              )}
            </div>
          ) : (
            <div className={d.tableWrap}>
              <table className={d.table}>
                <thead>
                  <tr>
                    <th><SortHead label="Name" active={sort === 'name'} desc={desc} onClick={() => sortBy('name')} /></th>
                    <th className={d.colOwner}>Owner</th>
                    <th className={d.colDate}><SortHead label="Last modified" active={sort === 'updated'} desc={desc} onClick={() => sortBy('updated')} /></th>
                    <th className={d.colSize}><SortHead label="File size" active={sort === 'size'} desc={desc} onClick={() => sortBy('size')} /></th>
                    <th className={d.colActions}><span className={d.srOnly}>Actions</span></th>
                  </tr>
                </thead>
                <tbody role="listbox" aria-multiselectable="true" aria-label={viewTitle}>
                  {ordered.map((i) => {
                    const dp = dragProps(i);
                    return (
                      <tr key={i.id} data-id={i.id} role="option" aria-selected={selected.has(i.id)}
                        className={`${selected.has(i.id) ? d.isSelected : ''} ${dropFolder === i.id ? d.isDropTarget : ''}`}
                        onClick={(e) => click(i, e)} onDoubleClick={() => open(i)} onContextMenu={(e) => openMenu(i, e)}
                        draggable={dp.draggable} onDragStart={dp.onDragStart} onDragEnd={dp.onDragEnd}
                        onDragOver={'onDragOver' in dp ? dp.onDragOver : undefined} onDragLeave={'onDragLeave' in dp ? dp.onDragLeave : undefined} onDrop={'onDrop' in dp ? dp.onDrop : undefined}>
                        <td>
                          <span className={d.nameCell}>
                            <TypeIcon item={i} size="sm" />
                            <Link to={itemLink(i)} onClick={(e) => e.stopPropagation()} draggable={false}>{i.name}</Link>
                            {i.starred && <span className={d.star} aria-label="Starred">★</span>}
                          </span>
                        </td>
                        <td className={d.colOwner}>{i.owner_id === userId ? 'me' : i.owner_name}</td>
                        <td className={d.colDate}>{shortDate(i.updated_at)}{i.owner_id === userId ? ' · me' : ''}</td>
                        <td className={d.colSize}>{i.kind === 'folder' ? '—' : formatSize(i.size_bytes)}</td>
                        <td className={d.colActions}>
                          <span className={d.rowTools}>
                            {view !== 'trash' && <button type="button" aria-label={`Share ${i.name}`} title="Share" onClick={(e) => { e.stopPropagation(); setSharing(i); }}>⇪</button>}
                            {i.kind === 'file' && <button type="button" aria-label={`Download ${i.name}`} title="Download" onClick={(e) => { e.stopPropagation(); download([i]); }}>⤓</button>}
                            {view !== 'trash' && <button type="button" aria-label={`${i.starred ? 'Unstar' : 'Star'} ${i.name}`} title={i.starred ? 'Remove from Starred' : 'Add to Starred'} onClick={(e) => { e.stopPropagation(); star([i]); }}>{i.starred ? '★' : '☆'}</button>}
                            <button type="button" aria-label={`More actions for ${i.name}`} onClick={(e) => { e.stopPropagation(); openMenu(i, e); }}>⋮</button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {(page > 0 || totalCount > PAGE) && (
            <nav className={d.pagination} aria-label="Pages">
              <button className={s.button} disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
              <span>{page * PAGE + 1}–{Math.min(totalCount, (page + 1) * PAGE)} of {totalCount.toLocaleString()}</span>
              <button className={s.button} disabled={(page + 1) * PAGE >= totalCount} onClick={() => setPage(page + 1)}>Next</button>
            </nav>
          )}
          {!files.isPending && all.length > 0 && <p className={d.footHint}>{all.length.toLocaleString()} of {totalCount.toLocaleString()} items · Double-click to open · Right-click for more · Drag onto a folder to move</p>}
        </main>

        {details && (
          <aside className={d.details} aria-label="Details">
            <header className={d.detailsHead}>
              {focused ? <TypeIcon item={focused} size="sm" /> : null}
              <strong>{focused ? focused.name : selectedItems.length ? `${selectedItems.length} items selected` : viewTitle}</strong>
              <button type="button" className={d.iconButton} aria-label="Close details" onClick={() => setDetails(false)}>×</button>
            </header>
            {focused ? (
              <>
                <div className={d.detailsPreview} data-type={fileTypeOf(focused)}><TypeIcon item={focused} size="lg" /></div>
                <dl className={d.detailsList}>
                  <div><dt>Type</dt><dd>{kindLabel(focused)}</dd></div>
                  {focused.kind !== 'folder' && <div><dt>Size</dt><dd>{formatSize(focused.size_bytes)}</dd></div>}
                  <div><dt>Owner</dt><dd>{focused.owner_id === userId ? 'me' : focused.owner_name}</dd></div>
                  <div><dt>Modified</dt><dd>{new Date(focused.updated_at).toLocaleString()}</dd></div>
                  <div><dt>Created</dt><dd>{new Date(focused.created_at).toLocaleString()}</dd></div>
                  <div><dt>Location</dt><dd>{folderId ? viewTitle : 'My files'}</dd></div>
                  <div><dt>Your access</dt><dd className={d.capitalize}>{focused.my_role ?? 'viewer'}</dd></div>
                </dl>
                <div className={d.detailsActions}>
                  <Link className={s.primary} to={itemLink(focused)}>Open</Link>
                  {view !== 'trash' && <button type="button" className={s.button} onClick={() => setSharing(focused)}>Manage access</button>}
                </div>
              </>
            ) : selectedItems.length ? (
              <dl className={d.detailsList}>
                <div><dt>Items</dt><dd>{selectedItems.length}</dd></div>
                <div><dt>Total size</dt><dd>{formatSize(selectedItems.reduce((n, i) => n + (i.size_bytes ?? 0), 0))}</dd></div>
              </dl>
            ) : (
              <>
                <div className={d.detailsPreview} data-type="folder"><TypeIcon item={{ kind: 'folder', name: '', mime_type: '', id: folderId }} size="lg" /></div>
                <dl className={d.detailsList}>
                  <div><dt>Items here</dt><dd>{totalCount.toLocaleString()}</dd></div>
                  <div><dt>Folders</dt><dd>{folders.length}</dd></div>
                  <div><dt>Files</dt><dd>{others.length}</dd></div>
                  <div><dt>Size of files</dt><dd>{formatSize(others.reduce((n, i) => n + (i.size_bytes ?? 0), 0))}</dd></div>
                  {currentFolder.data && <div><dt>Modified</dt><dd>{new Date(currentFolder.data.updated_at).toLocaleString()}</dd></div>}
                </dl>
                <p className={d.muted}>Select an item to see its details.</p>
              </>
            )}
          </aside>
        )}
      </div>

      {/* ── Overlays ── */}
      {fileDrag && (
        <div className={d.dropOverlay} role="status">
          <div>
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 16V4m0 0L7 9m5-5 5 5M5 20h14" /></svg>
            <strong>Drop files to upload</strong>
            <span>{view === 'trash' ? 'Open My files or a folder to upload.' : `They’ll be added to ${folderId ? `“${viewTitle}”` : 'My files'}.`}</span>
          </div>
        </div>
      )}

      {menu && <ItemMenu at={{ x: menu.x, y: menu.y }} actions={actionsFor(menu.ids)} onClose={() => setMenu(null)} />}

      {uploads.length > 0 && (
        <section className={d.tray} aria-live="polite" aria-label="Uploads">
          <header>
            <strong>{uploads.some((u) => u.progress < 100 && !u.error) ? `Uploading ${uploads.filter((u) => u.progress < 100 && !u.error).length} of ${uploads.length}` : `${uploads.filter((u) => u.progress === 100).length} upload${uploads.length === 1 ? '' : 's'} complete`}</strong>
            <button type="button" className={d.iconButton} aria-label={trayOpen ? 'Collapse' : 'Expand'} onClick={() => setTrayOpen(!trayOpen)}>{trayOpen ? '▾' : '▴'}</button>
            {!busy && <button type="button" className={d.iconButton} aria-label="Close uploads" onClick={() => setUploads([])}>×</button>}
          </header>
          {trayOpen && (
            <ul>
              {uploads.map((u, i) => (
                <li key={`${u.name}-${i}`}>
                  <TypeIcon item={{ kind: 'file', name: u.name, mime_type: u.file.type }} size="sm" />
                  <span className={d.trayName} title={u.name}>{u.name}{u.error && <em>{u.error}</em>}</span>
                  {u.error ? (!busy && <button type="button" className={d.textButton} onClick={() => void uploadFiles([u.file])}>Retry</button>)
                    : u.progress === 100 ? <span className={d.trayDone} aria-label="Uploaded">✓</span>
                      : <span className={d.trayRing} style={{ '--p': `${u.progress}%` } as React.CSSProperties} aria-label={`${u.progress}%`} />}
                </li>
              ))}
            </ul>
          )}
          {busy && uploads.some((u) => u.progress < 100 && !u.error) && <button type="button" className={d.textButton} onClick={() => abort.current?.abort()}>Cancel current upload</button>}
        </section>
      )}

      {toast && (
        <div className={d.toast} role="status">
          <span>{toast.text}</span>
          {toast.undo && <button type="button" onClick={() => { const u = toast.undo!; setToast(null); u().catch((e) => setError(errorText(e))); }}>Undo</button>}
          <button type="button" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
        </div>
      )}

      {renaming && <RenameDialog item={renaming} onClose={() => setRenaming(null)} onDone={refresh} />}
      {moving && <MoveDialog ws={ws} userId={userId} items={moving} startFolder={folderId ?? null} onClose={() => setMoving(null)}
        onDone={async () => { setSelected(new Set()); setToast({ text: `Moved ${moving.length === 1 ? `“${moving[0].name}”` : `${moving.length} items`}` }); await refresh(); }} />}
      {sharing && <DriveShareDialog open onClose={() => setSharing(null)} workspaceId={ws} userId={userId} itemId={sharing.id} itemName={sharing.name} itemKind={sharing.kind} onChanged={refresh} />}
      <Dialog open={!!create} onClose={() => setCreate(null)} title={create ? `New ${CREATE_LABELS[create]}` : ''} size="sm">
        <form className={s.form} onSubmit={createItem}>
          <input autoFocus onFocus={(e) => e.currentTarget.select()} className={s.input} aria-label="Name" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={255} required />
          {error && <p role="alert" className={s.error}>{error}</p>}
          <div className={d.dialogActions}>
            <button type="button" className={s.button} onClick={() => setCreate(null)}>Cancel</button>
            <button className={s.primary} disabled={busy || !newName.trim()}>{busy ? 'Creating…' : 'Create'}</button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function SortHead({ label, active, desc, onClick }: { label: string; active: boolean; desc: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`${d.sortHead} ${active ? d.sortHeadOn : ''}`} onClick={onClick}>
      {label}{active && <span aria-hidden="true">{desc ? ' ↓' : ' ↑'}</span>}
    </button>
  );
}

function FolderTitleMenu({ title, actions }: { title: string; actions: MenuAction[] }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button type="button" className={d.folderTitle} aria-haspopup="menu" aria-expanded={!!at} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt({ x: r.left, y: r.bottom + 4 }); }}>
        <h1>{title}</h1><span aria-hidden="true" className={d.caret}>▾</span>
      </button>
      {at && actions.length > 0 && <ItemMenu at={at} actions={actions} onClose={() => setAt(null)} />}
    </>
  );
}
