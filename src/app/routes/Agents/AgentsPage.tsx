import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { useAuth } from '@/hooks/useAuth';
import { Dialog } from '@/components/ui/Dialog';
import { platform, result, api, errorText, type RpcRow, type Row } from '@/features/platform/client';
import s from '@/features/platform/Platform.module.css';

type Agent=RpcRow<'agent_directory'>;
interface Availability {provider:{configured:boolean};embeddings:{configured:boolean};settings:{enabled:boolean;default_model:string;allowed_models:string[];web_research_enabled:boolean};usage:{workspace_month_tokens:number;user_day_tokens:number};tools:Array<{name:string;available:boolean;reason?:string}>}
export default function AgentsPage(){const {currentWorkspace,currentRole}=useWorkspaceContext();const {userId}=useAuth();return <Agents key={`${currentWorkspace!.id}:${userId}`} ws={currentWorkspace!.id} userId={userId!} admin={currentRole==='owner'||currentRole==='admin'}/>;}
function Agents({ws,userId,admin}:{ws:string;userId:string;admin:boolean}) {
  const {agentId,conversationId}=useParams();const [params]=useSearchParams();const navigate=useNavigate();const cache=useQueryClient();
  const [message,setMessage]=useState(params.get('crm')?`Summarize the CRM ${params.get('crm_kind')??'record'} ${params.get('crm')} and suggest a next step.`:'');const [error,setError]=useState('');const [sending,setSending]=useState(false);const [stream,setStream]=useState('');const [progress,setProgress]=useState('');
  const [settings,setSettings]=useState(false);const [sources,setSources]=useState<string[]>(params.get('source')?[params.get('source')!]:[]);const [picker,setPicker]=useState(false);const [filter,setFilter]=useState('');
  const mounted=useRef(true);const requestKey=useRef<string|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const base=['platform',ws,userId,'agents'];
  const directory=useQuery({queryKey:[...base,'directory'],queryFn:()=>result(platform.rpc('agent_directory',{p_workspace_id:ws})),staleTime:10000});
  const status=useQuery({queryKey:[...base,'status'],queryFn:async()=>await (await api(`ai/status?workspace_id=${ws}`)).json() as Availability,staleTime:30000,retry:false});
  const conversations=useQuery({queryKey:[...base,'conversations'],queryFn:()=>result(platform.from('agent_conversations').select('*').eq('workspace_id',ws).order('last_message_at',{ascending:false}).limit(50)),staleTime:5000});
  const conversation=conversations.data?.find(c=>c.id===conversationId);
  const chosenId=agentId??conversation?.agent_id;
  const agent=directory.data?.find(a=>a.id===chosenId);
  const timeline=useQuery({queryKey:[...base,'timeline',conversationId],queryFn:()=>result(platform.rpc('agent_conversation_timeline',{p_conversation_id:conversationId!})),enabled:!!conversationId,refetchInterval:2500,staleTime:0});
  const activity=useQuery({queryKey:[...base,'activity',conversationId],enabled:!!conversationId,refetchInterval:3000,queryFn:async()=>{
    const [runs,proposals]=await Promise.all([result(platform.from('agent_runs').select('*').eq('conversation_id',conversationId!).order('created_at',{ascending:false}).limit(20)),result(platform.from('agent_action_proposals').select('*').eq('conversation_id',conversationId!).order('created_at'))]);
    const citations=runs.length?await result(platform.from('agent_citations').select('*').in('run_id',runs.map(r=>r.id))):[];
    const events=runs.length?await result(platform.from('agent_run_events').select('*').eq('run_id',runs[0].id).order('created_at').limit(50)):[];
    return {runs,proposals,citations,events};
  }});
  const files=useQuery({queryKey:['platform',ws,userId,'agent-source-options'],enabled:picker,queryFn:()=>result(platform.rpc('drive_list',{p_workspace_id:ws,p_view:'all',p_limit:100}))});
  const refresh=()=>cache.invalidateQueries({queryKey:base});
  const running=activity.data?.runs.find(r=>['running','queued'].includes(r.status));
  const available=!!status.data?.provider.configured&&status.data.settings.enabled&&agent?.status==='active';
  async function send(e:React.FormEvent){
    e.preventDefault();if(!agent||!message.trim())return;setSending(true);setError('');setStream('');setProgress('Starting…');
    requestKey.current??=crypto.randomUUID();
    try {
      const response=await api('agents/run',{workspace_id:ws,agent_id:agent.id,conversation_id:conversationId??null,message,scope:{item_ids:sources,...(params.get('channel')?{channel_id:params.get('channel')}:{}),...(params.get('thread')?{thread_root_id:params.get('thread')}:{})},origin:{type:params.get('source')?'drive':params.get('channel')?'channel':'agents'},idempotency_key:requestKey.current});
      const reader=response.body!.getReader();const decoder=new TextDecoder();let buffer='';
      while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let boundary;
        while((boundary=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const name=event.match(/^event: (.+)$/m)?.[1];const raw=event.match(/^data: (.+)$/m)?.[1];if(!raw)continue;const data=JSON.parse(raw);if(!mounted.current)continue;
          if(name==='run'){requestKey.current=null;setMessage('');navigate(`/agents/conversations/${data.conversation_id}${params.toString()?`?${params}`:''}`,{replace:true});await refresh();}
          if(name==='delta')setStream(t=>t+data.text);
          if(name==='snapshot')setStream(data.text);
          if(name==='tool')setProgress(data.label);
          if(name==='done'){setProgress(data.status);if(data.error_message)setError(data.error_message);}
        }
      }
      await refresh();
    }catch(e){if(mounted.current)setError(`${errorText(e)} Reopen this conversation to recover its persisted status before retrying.`);}finally{if(mounted.current){setSending(false);setStream('');await refresh();}}
  }
  async function action(fn:()=>PromiseLike<unknown>){setError('');try{await fn();await refresh();}catch(e){setError(errorText(e));}}
  const showChat=!!chosenId||!!conversationId;
  return <div className={s.page}><header className={s.header}><div><div className={s.eyebrow}>Your AI team</div><h1>{showChat?agent?.name??'Conversation':'A specialist for your next step.'}</h1><p className={s.muted}>{showChat?agent?.capability:'Work with your conversations, documents, and projects. You stay in control.'}</p></div><div className={s.actions}>{showChat&&<Link className={s.button} to="/agents">All agents</Link>}{agent&&(admin||agent.created_by===userId)&&<button className={s.button} onClick={()=>setSettings(true)}>Agent settings</button>}</div></header>
    {status.isPending?<div className={s.notice}>Checking AI configuration…</div>:status.error?<div className={s.notice}>AI status is unavailable. Start the API server and configure its Supabase credentials. <button className={s.button} onClick={()=>void status.refetch()}>Retry</button></div>:!status.data?.provider.configured?<div className={s.notice}><strong>Connect your AI provider to start conversations.</strong><br/>An administrator must set ANTHROPIC_API_KEY on the server. Your files and conversations stay available.</div>:!status.data.settings.enabled?<div className={s.notice}>AI is disabled for this workspace.</div>:<div className={s.notice}>AI connected · {status.data.embeddings.configured?'Semantic and full-text retrieval':'Full-text retrieval · semantic search not configured'} · {status.data.usage.user_day_tokens.toLocaleString()} tokens used today</div>}
    {(error||directory.error||timeline.error||activity.error)&&<p className={s.error} role="alert">{error||errorText(directory.error??timeline.error??activity.error)}</p>}
    {!showChat?<><div className={s.toolbar}><input className={s.input} aria-label="Search agents" placeholder="Find an agent by name or specialty…" value={filter} onChange={e=>setFilter(e.target.value)}/></div>{directory.isPending?<p>Loading agents…</p>:<div className={s.grid}>{directory.data?.filter(a=>`${a.name} ${a.category}`.toLowerCase().includes(filter.toLowerCase())).map(a=><article key={a.id} className={s.card}><div className={s.badge} style={{borderBottom:`3px solid ${a.color}`}}>{a.name.slice(0,1)}</div><h2>{a.name}</h2><span className={s.pill}>{a.category}</span><p>{a.capability}</p><p className={s.muted}>{a.status==='disabled'?'Disabled':status.data?.provider.configured?'Ready to help':'Needs provider setup'}</p><Link className={s.button} to={`/agents/${a.id}${params.toString()?`?${params}`:''}`}>Open agent →</Link></article>)}</div>}<h2 className={s.section}>Continue a conversation</h2>{conversations.data?.length?<div className={s.stack}>{conversations.data.map(c=><Link key={c.id} className={`${s.card} ${s.link}`} to={`/agents/conversations/${c.id}`}>{c.title}<p className={s.muted}>{new Date(c.last_message_at).toLocaleString()}</p></Link>)}</div>:<div className={s.empty}>Your private agent conversations will appear here.</div>}</>:<div className={s.conversation}>
      <div className={s.actions}><span className={s.pill}>Private result · only you</span>{params.get('channel')&&<span className={s.pill}>{params.get('thread')?'Selected thread':'Selected channel'}</span>}<button className={s.button} onClick={()=>setPicker(true)}>{sources.length?`${sources.length} selected source(s)`:'Choose Drive sources'}</button></div>
      {!conversationId&&<div className={s.empty}><h2>How can I help?</h2><p>{agent?.description}</p><div className={s.stack}>{agent?.examples.map(ex=><button key={ex} className={s.button} onClick={()=>setMessage(ex)}>{ex}</button>)}</div></div>}
      {timeline.data?.map(m=><article key={m.id} className={`${s.message} ${m.role==='user'?s.user:''}`}><div className={s.eyebrow}>{m.role==='user'?'You':agent?.name??'Assistant'} · {m.status}</div>{m.content||'Working…'}{!m.redacted&&activity.data?.citations.filter(c=>c.message_id===m.id).map(c=><p key={c.id}><Link className={s.link} to={`/drive/item/${c.item_id}?${c.version_id?`version=${c.version_id}&`:c.revision_id?`revision=${c.revision_id}&`:''}page=${typeof c.location==='object'&&c.location&&!Array.isArray(c.location)?c.location.page??1:1}`}>[{c.ordinal}] Open source</Link>{c.quote&&<small className={s.muted}> — {c.quote}</small>}</p>)}</article>)}
      {sending&&stream&&<article className={s.message} aria-live="polite">{stream}</article>}{(sending||running)&&<p role="status" className={s.muted}>{progress||'Working…'}</p>}
      {activity.data?.proposals.map(p=><Proposal key={p.id} proposal={p} onChange={refresh}/>)}
      {activity.data?.runs[0]&&<details className={s.notice}><summary>Run activity · {activity.data.runs[0].status}</summary>{activity.data.runs[0].error_message&&<p>{activity.data.runs[0].error_message}</p>}{activity.data.events.map(e=><p key={e.id}>{e.type} · {new Date(e.created_at).toLocaleTimeString()}</p>)}</details>}
      <form className={s.form} onSubmit={send}><label>Message {agent?.name??'agent'}<textarea className={s.text} placeholder="Ask a question, request a summary, or draft your next step…" value={message} onChange={e=>{setMessage(e.target.value);requestKey.current=null;}} maxLength={20000} required disabled={sending}/></label><div className={s.actions}><button className={s.primary} disabled={!available||sending||!!running||!message.trim()}>Send message</button>{running&&<button type="button" className={s.button} onClick={()=>void action(()=>result(platform.rpc('agent_cancel_run',{p_run_id:running.id})))}>Stop generation</button>}<span className={s.muted}>Actions require your review before they run.</span></div></form>
    </div>}
    <Dialog open={picker} onClose={()=>setPicker(false)} title="Choose authorized sources"><div className={s.form}><p className={s.muted}>With no selection, the agent can search the sources its configuration permits and you can currently access.</p>{files.error&&<p role="alert">{errorText(files.error)}</p>}{files.data?.filter(f=>f.kind!=='folder').map(f=><label key={f.id} style={{display:'flex',alignItems:'center'}}><input type="checkbox" checked={sources.includes(f.id)} onChange={e=>setSources(v=>e.target.checked?[...v,f.id].slice(0,20):v.filter(id=>id!==f.id))}/>{f.name}</label>)}<button className={s.primary} onClick={()=>setPicker(false)}>Use selected sources</button></div></Dialog>
    {agent&&settings&&<AgentSettings agent={agent} onClose={()=>setSettings(false)} onSaved={refresh}/>}
  </div>;
}
function Proposal({proposal:p,onChange}:{proposal:Row<'agent_action_proposals'>;onChange:()=>Promise<unknown>}) {
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const args=p.arguments&&typeof p.arguments==='object'&&!Array.isArray(p.arguments)?p.arguments:{};
  const output=p.result&&typeof p.result==='object'&&!Array.isArray(p.result)?p.result:{};
  async function decide(approve:boolean){setBusy(true);setError('');try{await result(platform.rpc('agent_decide_proposal',{p_proposal_id:p.id,p_approve:approve,p_arguments_hash:p.arguments_hash}));await onChange();}catch(e){setError(errorText(e));}finally{setBusy(false);}}
  return <section className={s.card}><div className={s.eyebrow}>Review action · {p.status}</div><h2>{p.summary}</h2>{Object.entries(args).map(([k,v])=><div key={k}><strong className={s.muted}>{k.replaceAll('_',' ')}</strong><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{typeof v==='string'?v:JSON.stringify(v)}</p></div>)}{error&&<p role="alert" className={s.error}>{error}</p>}{p.status==='pending'&&<div className={s.actions}><button className={s.primary} disabled={busy} onClick={()=>void decide(true)}>Approve action</button><button className={s.button} disabled={busy} onClick={()=>void decide(false)}>Reject</button><span className={s.muted}>Expires {new Date(p.expires_at).toLocaleString()}</span></div>}{typeof output.item_id==='string'&&<Link to={`/drive/item/${output.item_id}`}>Open saved document</Link>}{typeof output.link==='string'&&output.link.startsWith('/crm/')&&<Link to={output.link}>Open updated record</Link>}{p.error&&<p role="alert" className={s.error}>{p.error}</p>}{typeof output.task_id==='string'&&<Link to={`/tasks/${output.task_id}`}>Open created task</Link>}</section>;
}
function AgentSettings({agent,onClose,onSaved}:{agent:Agent;onClose:()=>void;onSaved:()=>Promise<unknown>}) {
  const [error,setError]=useState('');const [instructions,setInstructions]=useState('');const [model,setModel]=useState(agent.model);const [busy,setBusy]=useState(false);
  const config=useQuery({queryKey:['platform',agent.id,'config'],queryFn:()=>result(platform.from('workspace_agent_versions').select('*').eq('agent_id',agent.id).order('version_no',{ascending:false}).limit(1).single())});
  useEffect(()=>{if(config.data)setInstructions(config.data.instructions);},[config.data]);
  return <Dialog open onClose={onClose} title={`${agent.name} settings`}><form className={s.form} onSubmit={e=>{e.preventDefault();setBusy(true);void result(platform.rpc('agent_save_config',{p_agent_id:agent.id,p_config:{instructions,model,tools:agent.tools,source_scope:agent.source_scope}})).then(async()=>{await onSaved();onClose();}).catch(e=>setError(errorText(e))).finally(()=>setBusy(false));}}><p className={s.muted}>Changes create an immutable configuration version. Existing runs retain their original configuration.</p><label>Model<input className={s.input} value={model} onChange={e=>setModel(e.target.value)} required/></label><label>Instructions<textarea className={s.text} value={instructions} onChange={e=>setInstructions(e.target.value)} maxLength={20000}/></label><p className={s.muted}>Allowed tools: {agent.tools.join(', ')}. Writes require review.</p>{(error||config.error)&&<p role="alert">{error||errorText(config.error)}</p>}<button className={s.primary} disabled={busy||!config.data}>Save new version</button></form></Dialog>;
}
