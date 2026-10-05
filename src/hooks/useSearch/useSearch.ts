import { useState, useEffect } from 'react';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { platform } from '@/features/platform/client';
export type SearchFilter='all'|'messages'|'channels'|'users'|'files'|'tasks'|'agents';
export interface SearchResultItem {id:string;type:'message'|'channel'|'user'|'file'|'task'|'agent';title:string;subtitle:string;avatar_url:string|null;link:string;created_at:string;metadata?:Record<string,unknown>}
const types:Record<SearchFilter,string[]|null>={all:null,messages:['message'],channels:['channel'],users:['person'],files:['file'],tasks:['task'],agents:['agent']};
export function useSearch(){
 const {currentWorkspace}=useWorkspaceContext();const [query,setQuery]=useState('');const [activeFilter,setFilter]=useState<SearchFilter>('all');const [results,setResults]=useState<SearchResultItem[]>([]);const [isLoading,setLoading]=useState(false);
 useEffect(()=>{setResults([]);if(!currentWorkspace||query.trim().length<2){setLoading(false);return;}let active=true;setLoading(true);const timer=setTimeout(()=>{void platform.rpc('search_workspace',{p_workspace_id:currentWorkspace.id,p_query:query,p_types:types[activeFilter],p_limit:30}).then(({data})=>{if(!active)return;setResults((data??[]).map(r=>({id:r.id,type:(r.result_type==='person'?'user':r.result_type==='file_text'?'file':r.result_type) as SearchResultItem['type'],title:r.title,subtitle:r.snippet,avatar_url:null,link:r.link,created_at:r.created_at})));setLoading(false);});},250);return()=>{active=false;clearTimeout(timer);};},[query,activeFilter,currentWorkspace?.id]);
 return{query,results,isLoading,activeFilter,search:setQuery,setFilter,clearSearch:()=>{setQuery('');setResults([]);}};
}
