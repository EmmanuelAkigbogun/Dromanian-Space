import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { useAuth } from '@/hooks/useAuth';
import { Dialog } from '@/components/ui/Dialog';
import { MediaViewer } from '@/components/ui/MediaViewer';
import { platform,result,errorText,api,type Row } from './client';
import s from './Platform.module.css';

type MessageResourceView = Row<'message_resources'> & {
 name:string|null;
 kind:string|null;
 mime_type:string|null;
 size_bytes:number|null;
 current_version_id:string|null;
};

type PdfPreview = { resourceId:string;name:string;src:string;size:number };

function isPdfResource(resource:MessageResourceView):boolean {
 return resource.kind==='file'&&(resource.mime_type==='application/pdf'||/\.pdf$/i.test(resource.name??''));
}

export function DriveShare({channelId,parentId}:{channelId:string;parentId?:string}){
 const {currentWorkspace}=useWorkspaceContext();const {userId}=useAuth();const [open,setOpen]=useState(false);const [selected,setSelected]=useState<string[]>([]);const [caption,setCaption]=useState('');const [grant,setGrant]=useState(false);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const key=useRef(crypto.randomUUID());
 const files=useQuery({queryKey:['platform',currentWorkspace?.id,userId,'drive-picker'],enabled:open&&!!currentWorkspace,queryFn:()=>result(platform.rpc('drive_list',{p_workspace_id:currentWorkspace!.id,p_view:'all',p_limit:100}))});
 const gap=useQuery({queryKey:['platform',currentWorkspace?.id,userId,'drive-gap',channelId,selected],enabled:open&&!!selected.length,queryFn:async()=>await result(platform.rpc('drive_conversation_access_check',{p_channel_id:channelId,p_item_ids:selected})) as Array<{item_id:string;members_without_access:number;can_grant:boolean}>});
 const gaps=gap.data?.filter(g=>g.members_without_access>0)??[];
 return <><button type="button" className={s.button} onClick={()=>setOpen(true)}>Share from Drive</button><Dialog open={open} onClose={()=>setOpen(false)} title="Share Drive items in this conversation"><form className={s.form} onSubmit={e=>{e.preventDefault();setBusy(true);setError('');void result(platform.rpc('send_drive_message',{p_channel_id:channelId,p_parent_id:parentId??null,p_content:caption,p_item_ids:selected,p_grant_channel:grant,p_request_id:key.current})).then(async id=>{window.dispatchEvent(new CustomEvent('drive-message-sent',{detail:{channelId,parentId}}));if(caption.includes('@'))void api('agents/mention',{message_id:id}).catch(()=>{});setOpen(false);setSelected([]);setCaption('');setGrant(false);key.current=crypto.randomUUID();}).catch(e=>setError(errorText(e))).finally(()=>setBusy(false));}}><p className={s.muted}>Share files, documents, or complete folders without creating copies.</p>{files.data?.map(f=><label key={f.id} style={{display:'flex'}}><input type="checkbox" checked={selected.includes(f.id)} onChange={e=>{setSelected(v=>e.target.checked?[...v,f.id].slice(0,20):v.filter(id=>id!==f.id));setGrant(false);key.current=crypto.randomUUID();}}/><span aria-hidden="true">{f.kind==='folder'?'▱':'≡'}</span> {f.name}</label>)}{gaps.length>0&&<div className={s.notice}>Some members cannot open {gaps.length} selected item(s).{gaps.every(g=>g.can_grant)?<label><input type="checkbox" checked={grant} onChange={e=>setGrant(e.target.checked)}/>Grant viewer access to this conversation’s current and future members</label>:<p>Ask an owner or editor to grant this conversation access before sharing.</p>}</div>}<label>Message<textarea className={s.text} value={caption} onChange={e=>{setCaption(e.target.value);key.current=crypto.randomUUID();}}/></label>{(error||files.error||gap.error)&&<p role="alert" className={s.error}>{error||errorText(files.error??gap.error)}</p>}<button className={s.primary} disabled={busy||!selected.length||gap.isPending||!!gap.error||(gaps.length>0&&(!grant||!gaps.every(g=>g.can_grant)))}>Share selected items</button></form></Dialog></>;
}
export function MessageResources({messageId,workspaceId}:{messageId:string;workspaceId:string|null}){
 const {userId}=useAuth();
 const [preview,setPreview]=useState<PdfPreview|null>(null);
 const [openingId,setOpeningId]=useState<string|null>(null);
 const [previewError,setPreviewError]=useState<{resourceId:string;message:string}|null>(null);
 const previewRequest=useRef(0);
 const files=useQuery<MessageResourceView[]>({queryKey:['platform',workspaceId,userId,'message-resources',messageId],staleTime:0,refetchInterval:30000,queryFn:async()=>{
  const refs=await result(platform.from('message_resources').select('*').eq('message_id',messageId)) as Row<'message_resources'>[];
  if(!refs.length)return[];
  const items=await result(platform.from('drive_items').select('id,name,kind,mime_type,size_bytes,current_version_id').in('id',refs.map(r=>r.item_id))) as Array<Pick<Row<'drive_items'>,'id'|'name'|'kind'|'mime_type'|'size_bytes'|'current_version_id'>>;
  return refs.map(ref=>{const item=items.find(candidate=>candidate.id===ref.item_id);return {...ref,name:item?.name??null,kind:item?.kind??null,mime_type:item?.mime_type??null,size_bytes:item?.size_bytes??null,current_version_id:item?.current_version_id??null};});
 }});
 const closePreview=()=>{previewRequest.current+=1;setPreview(null);setOpeningId(null);};
 const openPdf=async(resource:MessageResourceView)=>{
  const request=++previewRequest.current;
  setOpeningId(resource.id);
  setPreviewError(null);
  try{
   // A message may deliberately pin an older version. Never silently replace
   // it with the current file when that exact shared version is unavailable.
   const versionId=resource.version_id??resource.current_version_id;
   if(!versionId)throw new Error('This PDF has no available version. Open it in Drive for details.');
   const version=await result(platform.from('drive_versions').select('id,item_id,storage_bucket,storage_path,mime_type,size_bytes,status').eq('id',versionId).eq('item_id',resource.item_id).eq('status','ready').maybeSingle()) as Pick<Row<'drive_versions'>,'id'|'item_id'|'storage_bucket'|'storage_path'|'mime_type'|'size_bytes'|'status'>|null;
   if(request!==previewRequest.current)return;
   if(!version)throw new Error(resource.version_id?'This shared PDF version is unavailable or you no longer have access.':'This PDF is unavailable or you no longer have access.');
   const signed=await result(platform.storage.from(version.storage_bucket).createSignedUrl(version.storage_path,600)) as {signedUrl?:string};
   if(request!==previewRequest.current)return;
   if(!signed?.signedUrl)throw new Error('The PDF preview link could not be created. Please try again.');
   setPreview({resourceId:resource.id,name:resource.name??'Shared PDF',src:signed.signedUrl,size:version.size_bytes??resource.size_bytes??0});
  }catch(error){
   if(request===previewRequest.current)setPreviewError({resourceId:resource.id,message:errorText(error)});
  }finally{
   if(request===previewRequest.current)setOpeningId(null);
  }
 };
 return <>
  <div className={s.actions}>{files.data?.map(resource=>{
   const driveUrl=resource.kind==='folder'?`/drive/folder/${resource.item_id}`:`/drive/item/${resource.item_id}${resource.version_id?`?version=${resource.version_id}`:''}`;
   if(!isPdfResource(resource))return <Link className={s.button} key={resource.id} to={driveUrl}>{resource.kind==='folder'?'▱':'≡'} {resource.name??'Item unavailable'}</Link>;
   const opening=openingId===resource.id;
   const resourceError=previewError?.resourceId===resource.id?previewError.message:null;
   return <div className={s.resourcePreview} key={resource.id}>
    <button type="button" className={s.button} onClick={()=>void openPdf(resource)} disabled={opening} aria-haspopup="dialog" aria-busy={opening} aria-label={`Preview ${resource.name??'shared PDF'}`}>
     ≡ {opening?'Opening PDF…':resource.name??'Shared PDF'}
    </button>
    <Link className={s.button} to={driveUrl} aria-label={`Open ${resource.name??'shared PDF'} in Drive`}>Open in Drive</Link>
    {opening&&<span className={s.resourceStatus} role="status" aria-live="polite">Creating a secure preview…</span>}
    {resourceError&&<span className={s.resourceError} role="alert">{resourceError} <button type="button" className={s.inlineButton} onClick={()=>void openPdf(resource)}>Try again</button></span>}
   </div>;
  })}</div>
  <MediaViewer src={preview?.src??null} alt={preview?.name??''} type="embed" open={!!preview} onClose={closePreview} size={preview?.size}/>
 </>;
}
