import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { useAuth } from '@/hooks/useAuth';
import { Dialog } from '@/components/ui/Dialog';
import { platform, result, api, errorText, type RpcRow } from '@/features/platform/client';
import { DriveItem } from './DriveItem';
import s from '@/features/platform/Platform.module.css';

type Item = RpcRow<'drive_list'>;
export const driveViews = [['workspace','Workspace files'],['my','My files'],['shared','Shared with me'],['recent','Recent'],['starred','Starred'],['trash','Trash']] as const;
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
  const view = folderId ? 'folder' : params.get('view') ?? 'my';
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(0);
  const [grid, setGrid] = useState(false);
  const [create, setCreate] = useState<'folder'|'document'|null>(null);
  const [name,setName] = useState('');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [uploads,setUploads] = useState<Array<{name:string; progress:number; error?:string; file:File}>>([]);
  const abort = useRef<XMLHttpRequest|null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current=true; return () => { alive.current=false; abort.current?.abort(); }; }, []);
  const key = ['platform',ws,userId,'drive',view,folderId,search,sort,page];
  const files = useQuery({ queryKey:key, queryFn: () => result(platform.rpc('drive_list',{p_workspace_id:ws,p_view:search ? 'search' : view,p_folder_id:folderId ?? null,p_search:search,p_sort:sort,p_desc:sort==='updated',p_limit:50,p_offset:page*50,p_channel_id:params.get('channel')})), staleTime:10000, refetchInterval:30000 });
  const crumbs = useQuery({queryKey:['platform',ws,userId,'breadcrumbs',folderId],queryFn:()=>result(platform.rpc('drive_breadcrumbs',{p_item_id:folderId!})),enabled:!!folderId});
  const refresh = () => cache.invalidateQueries({queryKey:['platform',ws,userId]});
  async function createItem(e:React.FormEvent) {
    e.preventDefault(); setBusy(true);setError('');
    try {
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
        xhr.open('POST',`${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/${ticket.bucket}/${ticket.path.split('/').map(encodeURIComponent).join('/')}`);
        xhr.setRequestHeader('Authorization',`Bearer ${session.access_token}`);
        xhr.setRequestHeader('apikey',import.meta.env.VITE_SUPABASE_ANON_KEY);
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
    if(alive.current){setBusy(false);await refresh();void api('jobs/run',{workspace_id:ws}).catch(()=>setError('Upload saved. Indexing will start when the background worker is available.'));}
  }
  async function action(fn:()=>PromiseLike<unknown>) {setError('');try{await fn();await refresh();}catch(e){setError(errorText(e));}}
  if(itemId)return <DriveItem key={itemId} itemId={itemId} workspaceId={ws} userId={userId}/>;
  const itemLink=(i:Item)=>`/drive/${i.kind==='folder'?'folder':'item'}/${i.id}`;
  return <div className={s.page} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(!busy)void uploadFiles([...e.dataTransfer.files]);}}>
    <header className={s.header}><div><div className={s.eyebrow}>Shared knowledge · Drive</div><h1>{folderId ? crumbs.data?.at(-1)?.name ?? 'Folder' : driveViews.find(v=>v[0]===view)?.[1] ?? 'Drive'}</h1><p className={s.muted}>One place for your team’s files, documents, and ideas.</p></div><div className={s.actions}>
      <button className={s.button} onClick={()=>setCreate('folder')}>New folder</button><button className={s.button} onClick={()=>setCreate('document')}>New document</button>
      <label className={s.primary}>Upload files<input aria-label="Upload files" type="file" multiple disabled={busy} style={{position:'absolute',width:1,height:1,opacity:0}} onChange={e=>void uploadFiles([...(e.target.files ?? [])])}/></label>
    </div></header>
    {folderId && <nav className={s.actions} aria-label="Breadcrumb"><Link to="/drive?view=my">My files</Link>{crumbs.data?.map(c=><Link key={c.id} to={`/drive/folder/${c.id}`}> / {c.name}</Link>)}</nav>}
    <div className={s.tabs}>{driveViews.map(([id,label])=><Link key={id} className={`${s.button} ${view===id?s.active:''}`} to={`/drive?view=${id}`}>{label}</Link>)}</div>
    <div className={s.toolbar}><input className={s.input} value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}} placeholder="Search accessible files…" aria-label="Search files"/><select className={s.button} value={sort} onChange={e=>setSort(e.target.value)} aria-label="Sort files"><option value="name">Name</option><option value="updated">Last modified</option><option value="size">Size</option><option value="owner">Owner</option><option value="type">Type</option></select><button className={s.button} onClick={()=>setGrid(!grid)}>{grid?'List view':'Grid view'}</button></div>
    {(error||files.error)&&<div role="alert" className={s.error}>{error||errorText(files.error)}</div>}
    {uploads.map((u,i)=><div className={s.notice} key={i}><strong>{u.name}</strong> · {u.error ?? (u.progress===100?'Uploaded · indexing separately':`${u.progress}%`)} {u.progress<100&&!u.error&&busy&&<button className={s.button} onClick={()=>abort.current?.abort()}>Cancel current upload</button>}{u.error&&!busy&&<button className={s.button} onClick={()=>void uploadFiles([u.file])}>Retry</button>}</div>)}
    {files.isPending?<p role="status">Loading files…</p>:!files.data?.length?<div className={s.empty}><h2>No files here yet</h2><p>{view==='workspace'?'Files appear here when explicitly shared with the workspace.':'Upload a file or create a document to get started.'}</p></div>:grid?<div className={s.grid}>{files.data.map(i=><article className={s.card} key={i.id}><div className={s.badge}>{i.kind==='folder'?'▱':i.kind==='document'?'≡':'↗'}</div><h2><Link className={s.link} to={itemLink(i)}>{i.name}</Link></h2><p className={s.muted}>{i.owner_name} · {i.kind}</p></article>)}</div>:<div className={s.tableWrap}><table className={s.table}><thead><tr><th>Name</th><th>Owner</th><th>Modified</th><th>Size</th><th>Actions</th></tr></thead><tbody>{files.data.map(i=><tr key={i.id}><td><Link className={s.link} to={itemLink(i)}>{i.kind==='folder'?'▱':'≡'} {i.name}</Link><div className={s.muted}>{i.kind}</div></td><td>{i.owner_name}</td><td>{new Date(i.updated_at).toLocaleDateString()}</td><td>{i.size_bytes?`${Math.ceil(i.size_bytes/1024)} KB`:'—'}</td><td>{view==='trash'?<button className={s.button} onClick={()=>void action(()=>result(platform.rpc('drive_restore',{p_item_id:i.id})))}>Restore</button>:<button className={s.button} aria-label={`${i.starred?'Unstar':'Star'} ${i.name}`} onClick={()=>void action(()=>result(platform.rpc('drive_toggle_star',{p_item_id:i.id})))}>{i.starred?'★':'☆'}</button>}</td></tr>)}</tbody></table></div>}
    <div className={s.toolbar}><button className={s.button} disabled={page===0} onClick={()=>setPage(page-1)}>Previous</button><span className={s.muted}>Page {page+1} · {files.data?.[0]?.total_count ?? 0} items</span><button className={s.button} disabled={(page+1)*50>=(files.data?.[0]?.total_count ?? 0)} onClick={()=>setPage(page+1)}>Next</button></div>
    <Dialog open={!!create} onClose={()=>setCreate(null)} title={`New ${create}`}><form className={s.form} onSubmit={createItem}><label>Name<input autoFocus className={s.input} value={name} onChange={e=>setName(e.target.value)} maxLength={255} required/></label>{error&&<p role="alert">{error}</p>}<button className={s.primary} disabled={busy}>Create {create}</button></form></Dialog>
  </div>;
}
