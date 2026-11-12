import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { useAuth } from '@/hooks/useAuth';
import { Dialog } from '@/components/ui/Dialog';
import { DriveShareDialog } from '@/components/drive/DriveShareDialog';
import { Floating } from '@/lib/overlay/Floating';
import { platform, result, api, errorText, type RpcRow } from '@/features/platform/client';
import { DriveItem } from './DriveItem';
import s from '@/features/platform/Platform.module.css';
import d from './DrivePage.module.css';

type Item = RpcRow<'drive_list'>;
type CreateKind = 'folder'|'document'|'docx'|'xlsx'|'pptx';
type DriveView = (typeof driveViews)[number][0] | 'folder';
const CREATE_LABELS: Record<CreateKind,string> = { folder:'folder', document:'document', docx:'Word document', xlsx:'Excel spreadsheet', pptx:'PowerPoint presentation' };
export const driveViews = [['workspace','Workspace files'],['my','My files'],['shared','Shared with me'],['recent','Recent'],['starred','Starred'],['trash','Trash']] as const;

function fileKind(item: Item) {
  if (item.kind === 'folder') return 'Folder';
  if (item.kind === 'document') return 'Document';
  const extension = item.name.split('.').pop();
  return extension && extension !== item.name ? extension.toUpperCase() : 'File';
}

function isPdfItem(item: Item) {
  return item.kind === 'file' && (item.mime_type === 'application/pdf' || /\.pdf$/i.test(item.name));
}

function formatSize(bytes: number | null) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** power);
  return `${value >= 10 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}

function ItemIcon({ item }: { item: Item }) {
  if (item.kind === 'folder') {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2h9v10h-17z" /></svg>;
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 3.5h8l4 4v13H6zM14 3.5v4h4" /></svg>;
}

const EMPTY_COPY: Record<string, { title: string; body: string }> = {
  workspace: { title: 'No workspace files', body: 'Files appear here after someone shares them with the workspace.' },
  shared: { title: 'Nothing shared with you', body: 'Files and folders shared directly with you will appear here.' },
  recent: { title: 'No recent files', body: 'Files you open or update will appear here.' },
  starred: { title: 'No starred files', body: 'Star important files so they are easy to find.' },
  trash: { title: 'Trash is empty', body: 'Items you move to Trash will stay here until they are permanently removed.' },
  my: { title: 'Your Drive is empty', body: 'Create a document, folder, or upload a file to get started.' },
  folder: { title: 'This folder is empty', body: 'Create or upload something here to start organising your work.' },
};
export default function DrivePage() {
  const { currentWorkspace } = useWorkspaceContext();
  const { userId } = useAuth();
  const { itemId, folderId } = useParams();
  const [params] = useSearchParams();
  const ws = currentWorkspace!.id;
  return <DriveBrowser key={`${ws}:${userId}:${itemId ?? folderId ?? params.get('view') ?? 'my'}`} workspaceId={ws} userId={userId!} itemId={itemId} folderId={folderId} />;
}
function DriveBrowser({ workspaceId: ws, userId, itemId, folderId }: {workspaceId:string; userId:string; itemId?:string; folderId?:string}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const requestedView = params.get('view');
  const view: DriveView = folderId
    ? 'folder'
    : driveViews.some(([id]) => id === requestedView)
      ? requestedView as Exclude<DriveView, 'folder'>
      : 'my';
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(0);
  const [grid, setGrid] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [shareItem, setShareItem] = useState<Item | null>(null);
  const [dragging, setDragging] = useState(false);
  const [create, setCreate] = useState<CreateKind|null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const office = useQuery({ queryKey:['platform','office-status'], staleTime:300000, retry:false, queryFn: async () => (await (await api('office/status')).json()) as {enabled:boolean} });
  const [name,setName] = useState('');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [uploads,setUploads] = useState<Array<{name:string; progress:number; error?:string; file:File}>>([]);
  const uploadInput = useRef<HTMLInputElement|null>(null);
  const newMenuButton = useRef<HTMLButtonElement|null>(null);
  const newMenuList = useRef<HTMLDivElement|null>(null);
  const newMenuInitialFocus = useRef<'first'|'last'>('first');
  const abort = useRef<XMLHttpRequest|null>(null);
  const alive = useRef(true);
  const dragDepth = useRef(0);
  useEffect(() => { alive.current=true; return () => { alive.current=false; abort.current?.abort(); }; }, []);
  useEffect(() => {
    if (!newMenu) return;
    const items = newMenuList.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (!items?.length) return;
    items[newMenuInitialFocus.current === 'last' ? items.length - 1 : 0].focus();
  }, [newMenu]);
  const key = ['platform',ws,userId,'drive',view,folderId,deferredSearch,sort,page];
  const files = useQuery({ queryKey:key, queryFn: () => result(platform.rpc('drive_list',{p_workspace_id:ws,p_view:deferredSearch ? 'search' : view,p_folder_id:folderId ?? null,p_search:deferredSearch,p_sort:sort,p_desc:sort==='updated',p_limit:50,p_offset:page*50,p_channel_id:params.get('channel')})), staleTime:10000, refetchInterval:30000 });
  const crumbs = useQuery({queryKey:['platform',ws,userId,'breadcrumbs',folderId],queryFn:()=>result(platform.rpc('drive_breadcrumbs',{p_item_id:folderId!})),enabled:!!folderId});
  const selectedItems = useMemo(() => (files.data ?? []).filter(item => selected.has(item.id)), [files.data, selected]);
  const focusedItem = selectedItems.length === 1 ? selectedItems[0] : null;
  const totalCount = files.data?.[0]?.total_count ?? 0;
  useEffect(() => { setSelected(new Set()); }, [view, folderId, deferredSearch, sort, page]);
  const refresh = () => cache.invalidateQueries({queryKey:['platform',ws,userId]});
  async function createItem(e:React.FormEvent) {
    e.preventDefault(); setBusy(true);setError('');
    try {
      if (create === 'docx' || create === 'xlsx' || create === 'pptx') {
        // A blank Office file, opened straight in the editor.
        const created = await (await api('drive/new-office',{workspace_id:ws,parent_id:folderId ?? null,kind:create,name})).json() as {item_id:string};
        await refresh();setCreate(null);setName('');
        navigate(`/drive/item/${created.item_id}${office.data?.enabled ? '?edit=1' : ''}`);
        return;
      }
      const item = create === 'folder' ? await result(platform.rpc('drive_create_folder',{p_workspace_id:ws,p_parent_id:folderId ?? null,p_name:name})) : await result(platform.rpc('drive_create_document',{p_workspace_id:ws,p_parent_id:folderId ?? null,p_title:name,p_body:''}));
      await refresh();setCreate(null);setName('');
      navigate(`/drive/${item.kind==='folder'?'folder':'item'}/${item.id}`);
    } catch(e) { setError(errorText(e)); } finally {setBusy(false);}
  }
  async function upload(file:File) {
    if(file.size>50*1024*1024) throw new Error('Files must be 50 MB or smaller.');
    const ticket = await result(platform.rpc('drive_begin_upload',{p_workspace_id:ws,p_parent_id:folderId ?? null,p_name:file.name,p_mime_type:file.type || 'application/octet-stream',p_size_bytes:file.size})) as {version_id:string;bucket:string;path:string};
    try {
      const {data:{session}} = await platform.auth.getSession();
      if(!session) throw new Error('Please sign in again.');
      await new Promise<void>((resolve,reject)=>{
        const xhr = new XMLHttpRequest();abort.current=xhr;
        xhr.open('POST',`/api/storage/object/${encodeURIComponent(ticket.bucket)}/${ticket.path.split('/').map(encodeURIComponent).join('/')}`);
        xhr.setRequestHeader('Authorization',`Bearer ${session.access_token}`);
        xhr.setRequestHeader('Content-Type',file.type || 'application/octet-stream');
        xhr.upload.onprogress=e=>{if(e.lengthComputable&&alive.current)setUploads(u=>u.map(x=>x.file===file?{...x,progress:Math.round(e.loaded/e.total*95)}:x));};
        xhr.onload=()=>xhr.status<300?resolve():reject(new Error('Upload failed. Retry when your connection is available.'));
        xhr.onerror=()=>reject(new Error('Upload connection failed.'));
        xhr.onabort=()=>reject(new Error('Upload cancelled.'));
        xhr.send(file);
      });
      await result(platform.rpc('drive_finalize_upload',{p_version_id:ticket.version_id}));
      if(alive.current)setUploads(u=>u.map(x=>x.file===file?{...x,progress:100,error:undefined}:x));
    } catch(e) { await platform.rpc('drive_cancel_upload',{p_version_id:ticket.version_id});throw e; }
  }
  async function uploadFiles(files:File[]) {
    setBusy(true);setError('');
    setUploads(files.map(file=>({name:file.name,file,progress:0})));
    for(const file of files) {
      if(!alive.current)break;
      try {await upload(file);}catch(e){if(alive.current)setUploads(u=>u.map(x=>x.file===file?{...x,error:errorText(e)}:x));}
    }
    if(alive.current){
      setBusy(false);
      await refresh();
      if(!folderId && view!=='my') navigate('/drive?view=my');
      void api('jobs/run',{workspace_id:ws}).catch(()=>setError('Upload saved. Indexing will start when the background worker is available.'));
    }
  }
  async function action(fn:()=>PromiseLike<unknown>) {setError('');try{await fn();await refresh();}catch(e){setError(errorText(e));}}
  async function selectedAction(operation:(item:Item)=>PromiseLike<unknown>) {
    if (!selectedItems.length) return;
    setBusy(true);setError('');
    const outcomes = await Promise.allSettled(selectedItems.map(item => operation(item)));
    const failures = outcomes.filter(outcome => outcome.status === 'rejected');
    await refresh();
    if (failures.length) setError(`${failures.length} of ${outcomes.length} items could not be updated. Your access may have changed.`);
    else setSelected(new Set());
    setBusy(false);
  }
  function toggleSelected(id:string, additive = true) {
    setSelected(current => {
      const next = additive ? new Set(current) : new Set<string>();
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function onDragEnter(e:React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth.current += 1;
    setDragging(true);
  }
  function onDragLeave(e:React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  }
  function onDrop(e:React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepth.current = 0;setDragging(false);
    const dropped = [...e.dataTransfer.files];
    if (!busy && dropped.length) void uploadFiles(dropped);
  }
  function onNewMenuKeyDown(e:React.KeyboardEvent<HTMLDivElement>) {
    const items = [...(newMenuList.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    if (e.key === 'Tab') {
      setNewMenu(false);
      newMenuButton.current?.focus();
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (e.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    items[next].focus();
  }
  if(itemId)return <DriveItem key={itemId} itemId={itemId} workspaceId={ws} userId={userId}/>;
  const itemLink=(i:Item)=>`/drive/${i.kind==='folder'?'folder':'item'}/${i.id}${isPdfItem(i)?'?edit=1':''}`;
  const viewTitle = folderId ? crumbs.data?.at(-1)?.name ?? 'Folder' : driveViews.find(([id])=>id===view)?.[1] ?? 'Drive';
  const empty = EMPTY_COPY[view] ?? EMPTY_COPY.my;
  const allSelected = !!files.data?.length && files.data.every(item => selected.has(item.id));
  const canTrashSelection = selectedItems.length > 0 && selectedItems.every(item => item.my_role === 'owner' || item.my_role === 'editor');
  return <div className={`${s.page} ${d.drivePage}`} onDragEnter={onDragEnter} onDragOver={e=>e.preventDefault()} onDragLeave={onDragLeave} onDrop={onDrop}>
    <header className={d.pageHeader}>
      <div className={d.titleBlock}>
        {folderId && <nav className={d.breadcrumbs} aria-label="Breadcrumb"><Link to="/drive?view=my">My files</Link>{crumbs.data?.slice(0,-1).map(c=><span key={c.id}><span aria-hidden="true">/</span><Link to={`/drive/folder/${c.id}`}>{c.name}</Link></span>)}</nav>}
        <div className={d.titleLine}><h1>{viewTitle}</h1>{!files.isPending&&<span>{totalCount.toLocaleString()} {totalCount===1?'item':'items'}</span>}</div>
      </div>
      <div className={d.headerActions}>
        <div className={d.newMenu}><button ref={newMenuButton} className={`${s.primary} ${d.newButton}`} aria-haspopup="menu" aria-expanded={newMenu} aria-controls="drive-new-menu" onClick={()=>{newMenuInitialFocus.current='first';setNewMenu(v=>!v);}} onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();newMenuInitialFocus.current=e.key==='ArrowUp'?'last':'first';setNewMenu(true);}}}><span aria-hidden="true">＋</span>New</button><Floating id="drive-new-menu" ref={newMenuList} open={newMenu} anchor={newMenuButton} placement="bottom-start" onDismiss={()=>{setNewMenu(false);newMenuButton.current?.focus();}} onKeyDown={onNewMenuKeyDown} className={d.menu} role="menu">{(['folder','document','docx','xlsx','pptx'] as CreateKind[]).map(k=><button key={k} role="menuitem" tabIndex={-1} className={d.menuItem} onClick={()=>{setNewMenu(false);setName('');setCreate(k);}}><span className={d.menuIcon} data-kind={k}>{k==='folder'?'▱':k==='document'?'≡':k==='docx'?'W':k==='xlsx'?'X':'P'}</span>{k==='document'?'Document (Markdown)':CREATE_LABELS[k][0].toUpperCase()+CREATE_LABELS[k].slice(1)}</button>)}</Floating></div>
        <button className={s.button} type="button" disabled={busy} onClick={()=>uploadInput.current?.click()}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16V4m0 0L7 9m5-5 5 5M5 20h14"/></svg>
          {busy?'Working…':'Upload'}
        </button>
        <input ref={uploadInput} className={s.fileInput} aria-label="Upload files from computer" type="file" multiple disabled={busy} onChange={e=>{const picked=[...(e.currentTarget.files ?? [])];e.currentTarget.value='';if(picked.length)void uploadFiles(picked);}}/>
      </div>
    </header>

    <nav className={d.mobileViews} aria-label="Drive views">{driveViews.map(([id,label])=><Link key={id} className={view===id?d.mobileViewActive:undefined} to={`/drive?view=${id}`}>{label}</Link>)}</nav>

    <div className={d.controlBar}>
      <label className={d.searchBox}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>
        <span className={d.srOnly}>Search Drive</span>
        <input value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}} placeholder="Search in Drive" />
        {search&&<button type="button" aria-label="Clear search" onClick={()=>setSearch('')}>×</button>}
      </label>
      <label className={d.sortControl}><span>Sort</span><select value={sort} onChange={e=>{setSort(e.target.value);setPage(0);}} aria-label="Sort files"><option value="name">Name</option><option value="updated">Last modified</option><option value="size">Size</option><option value="owner">Owner</option><option value="type">Type</option></select></label>
      <div className={d.viewSwitch} role="group" aria-label="View files as">
        <button type="button" aria-label="List view" aria-pressed={!grid} onClick={()=>setGrid(false)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg></button>
        <button type="button" aria-label="Grid view" aria-pressed={grid} onClick={()=>setGrid(true)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg></button>
      </div>
    </div>

    {selectedItems.length>0&&<div className={d.selectionBar} role="toolbar" aria-label="Selected file actions">
      <strong>{selectedItems.length} selected</strong>
      <button type="button" onClick={()=>setSelected(new Set())}>Clear</button>
      {selectedItems.length===1&&<Link to={itemLink(selectedItems[0])}>{isPdfItem(selectedItems[0])?'Open PDF':'Open'}</Link>}
      {selectedItems.length===1&&view!=='trash'&&<button type="button" onClick={()=>setShareItem(selectedItems[0])}>Share</button>}
      {view==='trash'?<button type="button" disabled={busy} onClick={()=>void selectedAction(item=>result(platform.rpc('drive_restore',{p_item_id:item.id})))}>Restore</button>:<button type="button" disabled={busy} onClick={()=>{const remove=selectedItems.every(item=>item.starred);void selectedAction(item=>(remove||!item.starred)?result(platform.rpc('drive_toggle_star',{p_item_id:item.id})):Promise.resolve());}}>{selectedItems.every(item=>item.starred)?'Remove star':'Add to Starred'}</button>}
      {view!=='trash'&&canTrashSelection&&<button type="button" disabled={busy} className={d.dangerAction} onClick={()=>void selectedAction(item=>result(platform.rpc('drive_trash',{p_item_id:item.id})))}>Move to Trash</button>}
    </div>}

    {(error||files.error)&&<div role="alert" className={s.error}>{error||errorText(files.error)}</div>}
    {uploads.length>0&&<div className={d.uploads} aria-live="polite">{uploads.map((u,i)=><div className={s.notice} key={`${u.name}-${i}`}><div><strong>{u.name}</strong><span>{u.error ?? (u.progress===100?'Uploaded · indexing separately':`${u.progress}%`)}</span></div>{!u.error&&<progress max="100" value={u.progress}>{u.progress}%</progress>}{u.progress<100&&!u.error&&busy&&<button className={s.button} onClick={()=>abort.current?.abort()}>Cancel</button>}{u.error&&!busy&&<button className={s.button} onClick={()=>void uploadFiles([u.file])}>Retry</button>}</div>)}</div>}

    <div className={`${d.contentLayout} ${selectedItems.length?d.withDetails:''}`}>
      <main className={d.fileArea}>
        {files.isPending?<div className={d.loading} role="status"><span/>Loading files…</div>:!files.data?.length?<div className={`${s.empty} ${d.empty}`}><div className={d.emptyIcon}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2h9v10h-17z"/></svg></div><h2>{deferredSearch?'No matching files':empty.title}</h2><p>{deferredSearch?'Try another name or clear the search.':empty.body}</p>{!deferredSearch&&view!=='trash'&&<button className={s.primary} type="button" disabled={busy} onClick={()=>uploadInput.current?.click()}>Upload a file</button>}</div>:grid?<div className={d.fileGrid}>{files.data.map(item=><article className={`${d.fileCard} ${selected.has(item.id)?d.selected:''}`} key={item.id}><label className={d.cardSelect}><input type="checkbox" checked={selected.has(item.id)} onChange={()=>toggleSelected(item.id)} aria-label={`Select ${item.name}`}/></label><div className={d.cardTop}><span className={d.itemIcon}><ItemIcon item={item}/></span>{view!=='trash'&&<button className={d.starButton} aria-label={`${item.starred?'Unstar':'Star'} ${item.name}`} onClick={()=>void action(()=>result(platform.rpc('drive_toggle_star',{p_item_id:item.id})))}>{item.starred?'★':'☆'}</button>}</div><Link className={d.fileName} to={itemLink(item)}>{item.name}</Link><div className={d.cardMeta}><span>{fileKind(item)}</span><span>{new Date(item.updated_at).toLocaleDateString()}</span></div>{view!=='trash'&&<button type="button" className={d.cardShareButton} onClick={()=>setShareItem(item)}>Share</button>}</article>)}</div>:<div className={d.fileTableWrap}><table className={d.fileTable}><thead><tr><th className={d.checkboxCell}><input type="checkbox" checked={allSelected} onChange={()=>setSelected(allSelected?new Set():new Set(files.data?.map(item=>item.id)))} aria-label={allSelected?'Clear page selection':'Select all files on this page'}/></th><th>Name</th><th>Owner</th><th>Last modified</th><th>Size</th><th><span className={d.srOnly}>Actions</span></th></tr></thead><tbody>{files.data.map(item=><tr className={selected.has(item.id)?d.selected:undefined} key={item.id}><td className={d.checkboxCell}><input type="checkbox" checked={selected.has(item.id)} onChange={()=>toggleSelected(item.id)} aria-label={`Select ${item.name}`}/></td><td><div className={d.nameCell}><span className={d.itemIcon}><ItemIcon item={item}/></span><div><Link to={itemLink(item)}>{item.name}</Link><span>{fileKind(item)}</span></div></div></td><td>{item.owner_name}</td><td>{new Date(item.updated_at).toLocaleDateString()}</td><td>{formatSize(item.size_bytes)}</td><td className={d.rowActions}>{view==='trash'?<button onClick={()=>void action(()=>result(platform.rpc('drive_restore',{p_item_id:item.id})))}>Restore</button>:<div className={d.rowActionGroup}><button type="button" className={d.shareAction} onClick={()=>setShareItem(item)}>Share</button><button className={d.starButton} aria-label={`${item.starred?'Unstar':'Star'} ${item.name}`} onClick={()=>void action(()=>result(platform.rpc('drive_toggle_star',{p_item_id:item.id})))}>{item.starred?'★':'☆'}</button></div>}</td></tr>)}</tbody></table></div>}
        {(page>0||totalCount>50)&&<nav className={d.pagination} aria-label="Files pages"><button className={s.button} disabled={page===0} onClick={()=>setPage(page-1)}>Previous</button><span>Page {page+1} · {totalCount.toLocaleString()} items</span><button className={s.button} disabled={(page+1)*50>=totalCount} onClick={()=>setPage(page+1)}>Next</button></nav>}
      </main>

      {selectedItems.length>0&&<aside className={d.detailsPane} aria-label="Selection details">
        <div className={d.detailsHeader}><strong>{focusedItem?'Details':'Selection'}</strong><button type="button" aria-label="Close details" onClick={()=>setSelected(new Set())}>×</button></div>
        {focusedItem?<><div className={d.detailsIdentity}><span className={d.detailIcon}><ItemIcon item={focusedItem}/></span><h2>{focusedItem.name}</h2><span>{fileKind(focusedItem)}</span></div><dl><div><dt>Owner</dt><dd>{focusedItem.owner_name}</dd></div><div><dt>Modified</dt><dd>{new Date(focusedItem.updated_at).toLocaleString()}</dd></div><div><dt>Size</dt><dd>{formatSize(focusedItem.size_bytes)}</dd></div><div><dt>Your access</dt><dd>{focusedItem.my_role ?? 'Viewer'}</dd></div><div><dt>Location</dt><dd>{viewTitle}</dd></div></dl><div className={d.detailActions}><Link className={s.primary} to={itemLink(focusedItem)}>{isPdfItem(focusedItem)?'Open PDF':`Open ${focusedItem.kind==='folder'?'folder':'file'}`}</Link>{view!=='trash'&&<button type="button" className={s.button} onClick={()=>setShareItem(focusedItem)}>Share</button>}</div></>:<div className={d.selectionSummary}><strong>{selectedItems.length} items</strong><span>{formatSize(selectedItems.reduce((sum,item)=>sum+(item.size_bytes??0),0))} total</span></div>}
      </aside>}
    </div>
    {dragging&&<div className={d.dropOverlay} role="status"><div><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 16V4m0 0L7 9m5-5 5 5M5 20h14"/></svg><strong>Drop files to upload</strong><span>{folderId?`They will be added to ${viewTitle}.`:'They will be added to My files.'}</span></div></div>}
    {shareItem&&<DriveShareDialog open={true} onClose={()=>setShareItem(null)} workspaceId={ws} userId={userId} itemId={shareItem.id} itemName={shareItem.name} itemKind={shareItem.kind} onChanged={refresh}/>}
    <Dialog open={!!create} onClose={()=>setCreate(null)} title={create ? `New ${CREATE_LABELS[create]}` : ''}><form className={s.form} onSubmit={createItem}><label>Name<input autoFocus className={s.input} value={name} onChange={e=>setName(e.target.value)} maxLength={255} required/></label>{error&&<p role="alert">{error}</p>}<button className={s.primary} disabled={busy}>{busy?'Creating…':`Create ${create ? CREATE_LABELS[create] : ''}`}</button></form></Dialog>
  </div>;
}
