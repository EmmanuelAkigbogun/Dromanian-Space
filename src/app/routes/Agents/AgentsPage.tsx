import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { useAuth } from '@/hooks/useAuth';
import { Dialog } from '@/components/ui/Dialog';
import { Markdown } from '@/components/ui/Markdown';
import { platform, result, api, errorText, type RpcRow, type Row } from '@/features/platform/client';
import s from '@/features/platform/Platform.module.css';
import a from './Agents.module.css';

type Agent = RpcRow<'agent_directory'>;
type TimelineRow = RpcRow<'agent_conversation_timeline'>;

interface Status {
  provider: { configured: boolean };
  data_flow: { generation: string; embeddings: string; storage: string };
  embeddings: { configured: boolean };
  web_research: { enabled_by_admin: boolean; available: boolean };
  crm: { installed: boolean };
  site: { url: string | null };
  brand_kit: { folder_id: string | null };
  connectors: Array<{ kind: string; label: string; status: string }>;
  settings: {
    enabled: boolean;
    default_model: string;
    allowed_models: string[];
    mention_reply_policy: string;
    web_research_enabled: boolean;
  };
  usage: { workspace_month_tokens: number; user_day_tokens: number };
  tools: Array<{ name: string; available: boolean; reason?: string; approval: 'none' | 'review_card' }>;
}

interface LiveTask {
  task_id: string;
  agent: string;
  status: string;
}

const TOOL_LABELS: Record<string, string> = {
  search_workspace: 'Search messages, files, tasks and people you can access',
  search_knowledge: 'Search indexed documents',
  read_file: 'Read a file you can open',
  read_conversation: 'Read conversations you belong to',
  list_tasks: 'List tasks you can see',
  read_crm_record: 'Read CRM records',
  compute_csv_metrics: 'Calculate metrics from a CSV file',
  workspace_metrics: 'Calculate workspace metrics',
  web_search: 'Search the web',
  fetch_site_page: 'Read pages of your site',
  read_calendar: 'Read your calendar',
  read_brand_kit: 'Read the brand kit',
  read_personal_notes: 'Read your private notes',
  save_personal_note: 'Save a private note',
  delegate_to_specialists: 'Assign tasks to specialists',
  propose_task: 'Create tasks',
  propose_document: 'Save documents to Drive',
  propose_channel_message: 'Post messages',
  propose_crm_update: 'Update CRM records',
  propose_calendar_event: 'Add calendar events',
};

const CONNECTED_ACTIONS: Record<string, string> = {
  support_inbox: 'replying to tickets',
  commerce_store: 'reading live store data',
  email_platform: 'sending or scheduling email',
  recruiting: 'reading applicant records',
  search_analytics: 'using search analytics',
  social_accounts: 'publishing or scheduling posts',
  email_inbox: 'summarizing your inbox',
};

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'awaiting_approval']);

/** What stops an agent from working, and what only limits it. */
function readiness(agent: Agent, status: Status | undefined) {
  const blocking: string[] = [];
  const notes: string[] = [];
  if (!status) return { blocking: ['Checking configuration…'], notes };
  if (!status.provider.configured) blocking.push('The AI provider is not configured on the server (an administrator sets ANTHROPIC_API_KEY).');
  if (!status.settings.enabled) blocking.push('AI is turned off for this workspace.');
  if (agent.status !== 'active') blocking.push('This agent is disabled.');
  if (agent.requires.includes('crm') && !status.crm.installed) blocking.push('Needs the CRM, which is not set up yet.');
  if (agent.requires.includes('site_url') && !status.site.url) blocking.push('Needs your site address in AI settings.');
  for (const kind of agent.connectors) {
    const c = status.connectors.find((x) => x.kind === kind);
    if (c?.status !== 'connected') notes.push(`${c?.label ?? kind} not connected — ${CONNECTED_ACTIONS[kind] ?? 'connected actions'} unavailable.`);
  }
  if (agent.tools.includes('read_brand_kit') && !status.brand_kit.folder_id) notes.push('No brand kit folder chosen; drafts follow general guidance.');
  if (agent.tools.includes('web_search') && !status.web_research.enabled_by_admin) notes.push('Web research is off; it works from workspace sources.');
  return { blocking, notes };
}

function Avatar({ agent, small }: { agent: Pick<Agent, 'name' | 'color'>; small?: boolean }) {
  return (
    <span className={small ? a.mini : a.avatar} style={{ background: agent.color }} aria-hidden="true">
      {agent.name.slice(0, 1)}
    </span>
  );
}

function ReadinessLine({ agent, status }: { agent: Agent; status: Status | undefined }) {
  const { blocking, notes } = readiness(agent, status);
  const tone = blocking.length ? a.blocked : notes.length ? a.limited : a.ready;
  // Workspace-wide blockers are explained in the banner; cards stay short.
  const short = !status?.provider.configured ? 'Waiting for AI provider setup' : !status.settings.enabled ? 'AI is off in this workspace' : blocking[0];
  const text = blocking.length ? short : notes.length ? `Ready · ${notes.length} connected action${notes.length === 1 ? '' : 's'} unavailable` : 'Ready';
  return (
    <p className={a.state}>
      <span className={`${a.dot} ${tone}`} />
      <span>{text}</span>
    </p>
  );
}

/** Reads a server-sent event stream from fetch (EventSource cannot send auth headers). */
async function consumeEvents(response: Response, onEvent: (name: string, data: Record<string, unknown>) => void | Promise<void>) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const name = /^event: (.+)$/m.exec(chunk)?.[1];
      const raw = /^data: (.+)$/m.exec(chunk)?.[1];
      if (name && raw) await onEvent(name, JSON.parse(raw));
    }
  }
}

export default function AgentsPage() {
  const { currentWorkspace, currentRole } = useWorkspaceContext();
  const { userId } = useAuth();
  return (
    <Agents
      key={`${currentWorkspace!.id}:${userId}`}
      ws={currentWorkspace!.id}
      userId={userId!}
      admin={currentRole === 'owner' || currentRole === 'admin'}
    />
  );
}

function Agents({ ws, userId, admin }: { ws: string; userId: string; admin: boolean }) {
  const { agentId, conversationId } = useParams();
  const base = ['platform', ws, userId, 'agents'];
  const [aiSettings, setAiSettings] = useState(false);
  const directory = useQuery({
    queryKey: [...base, 'directory'],
    queryFn: () => result(platform.rpc('agent_directory', { p_workspace_id: ws })),
    staleTime: 10000,
  });
  const status = useQuery({
    queryKey: [...base, 'status'],
    queryFn: async () => (await (await api(`ai/status?workspace_id=${ws}`)).json()) as Status,
    staleTime: 30000,
    retry: false,
  });
  const conversations = useQuery({
    queryKey: [...base, 'conversations'],
    queryFn: () =>
      result(platform.from('agent_conversations').select('*').eq('workspace_id', ws).order('last_message_at', { ascending: false }).limit(100)),
    staleTime: 5000,
  });

  const conversation = conversations.data?.find((c) => c.id === conversationId);
  const coordinator = directory.data?.find((d) => d.kind === 'coordinator');
  const chosenId = agentId === 'team' ? coordinator?.id : (agentId ?? conversation?.agent_id);
  const agent = directory.data?.find((d) => d.id === chosenId);
  const archived = !!conversationId && !!conversation && !agent;

  const notice = status.isPending ? (
    <div className={s.notice}>Checking AI configuration…</div>
  ) : status.error ? (
    <div className={s.notice}>
      AI status is unavailable. The API server may be down. <button className={s.button} onClick={() => void status.refetch()}>Retry</button>
    </div>
  ) : !status.data?.provider.configured ? (
    <div className={s.notice}>
      <strong>Connect an AI provider to start conversations.</strong>
      <br />
      An administrator sets ANTHROPIC_API_KEY on the server. Agents, files and earlier conversations stay available.
    </div>
  ) : !status.data.settings.enabled ? (
    <div className={s.notice}>AI is turned off for this workspace.</div>
  ) : (
    <div className={s.notice}>
      AI connected · {status.data.embeddings.configured ? 'semantic and full-text retrieval' : 'full-text retrieval (semantic search not configured)'} ·{' '}
      {status.data.usage.user_day_tokens.toLocaleString()} tokens used today
    </div>
  );

  return (
    <div className={s.page}>
      {chosenId || conversationId ? (
        agent || archived ? (
          <AgentView
            ws={ws}
            userId={userId}
            admin={admin}
            agent={agent}
            directory={directory.data ?? []}
            status={status.data}
            notice={notice}
            conversationId={conversationId}
            conversations={(conversations.data ?? []).filter((c) => c.agent_id === (agent?.id ?? conversation?.agent_id))}
            onOpenAiSettings={() => setAiSettings(true)}
          />
        ) : directory.isPending || conversations.isPending ? (
          <p className={s.muted}>Loading…</p>
        ) : (
          <div className={s.empty}>
            This agent is not available to you. <Link to="/agents">Back to all agents</Link>
          </div>
        )
      ) : (
        <Directory
          agents={directory.data ?? []}
          loading={directory.isPending}
          error={directory.error}
          status={status.data}
          notice={notice}
          admin={admin}
          conversations={conversations.data ?? []}
          onOpenAiSettings={() => setAiSettings(true)}
        />
      )}
      {aiSettings && status.data && <AiSettings ws={ws} status={status.data} onClose={() => setAiSettings(false)} onSaved={() => void status.refetch()} />}
    </div>
  );
}

function Directory(props: {
  agents: Agent[];
  loading: boolean;
  error: unknown;
  status: Status | undefined;
  notice: React.ReactNode;
  admin: boolean;
  conversations: Row<'agent_conversations'>[];
  onOpenAiSettings: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [params] = useSearchParams();
  const query = params.toString() ? `?${params}` : '';
  const specialists = props.agents.filter((x) => x.kind === 'specialist');
  const coordinator = props.agents.find((x) => x.kind === 'coordinator');
  const names = new Map(props.agents.map((x) => [x.id, x.name]));
  const shown = specialists.filter((x) => `${x.name} ${x.job ?? ''} ${x.category} ${x.handle}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <header className={s.header}>
        <div>
          <div className={s.eyebrow}>Your AI team</div>
          <h1>Twelve specialists, one team.</h1>
          <p className={s.muted}>Each works only with what you can access. Anything that changes data waits for your review.</p>
        </div>
        {props.admin && (
          <div className={s.actions}>
            <button className={s.button} onClick={props.onOpenAiSettings} disabled={!props.status}>AI settings</button>
          </div>
        )}
      </header>
      {props.notice}
      {props.error ? <p className={s.error} role="alert">{errorText(props.error)}</p> : null}
      {coordinator && (
        <section className={a.hero} aria-labelledby="team-chat">
          <div>
            <div className={s.eyebrow}>Team Chat</div>
            <h2 id="team-chat">Ask the whole team</h2>
            <p>{coordinator.capability} Each specialist’s part is shown with its author, and nothing they propose happens without your approval.</p>
          </div>
          <Link className={s.primary} to={`/agents/team${query}`}>Start a team chat</Link>
        </section>
      )}
      <div className={s.toolbar}>
        <input className={s.input} aria-label="Search agents" placeholder="Find a specialist by name or role…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {props.loading ? (
        <p className={s.muted}>Loading agents…</p>
      ) : (
        <div className={s.grid}>
          {shown.map((x) => (
            <article key={x.id} className={s.card}>
              <div className={a.cardTop}>
                <Avatar agent={x} />
                <div>
                  <h2>{x.name}</h2>
                  <div className={a.role}>{x.job}</div>
                </div>
              </div>
              <p>{x.capability}</p>
              <ReadinessLine agent={x} status={props.status} />
              <p className={a.handle}>Mention @{x.handle} in a conversation</p>
              <div className={a.cardActions}>
                <Link className={s.button} to={`/agents/${x.id}${query}`}>Chat with {x.name} →</Link>
              </div>
            </article>
          ))}
          {!shown.length && <div className={s.empty}>No specialist matches “{filter}”.</div>}
        </div>
      )}
      <h2 className={s.section}>Continue a conversation</h2>
      {props.conversations.length ? (
        <div className={s.stack}>
          {props.conversations.slice(0, 20).map((c) => (
            <Link key={c.id} className={`${s.card} ${s.link}`} to={`/agents/conversations/${c.id}`}>
              {c.title}
              <p className={s.muted}>
                {names.get(c.agent_id) ?? 'Retired agent'} · {new Date(c.last_message_at).toLocaleString()}
              </p>
            </Link>
          ))}
        </div>
      ) : (
        <div className={s.empty}>Your private agent conversations will appear here.</div>
      )}
    </>
  );
}

function AgentView(props: {
  ws: string;
  userId: string;
  admin: boolean;
  agent: Agent | undefined;
  directory: Agent[];
  status: Status | undefined;
  notice: React.ReactNode;
  conversationId: string | undefined;
  conversations: Row<'agent_conversations'>[];
  onOpenAiSettings: () => void;
}) {
  const { ws, userId, agent, conversationId } = props;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const base = ['platform', ws, userId, 'agents'];
  const initial = params.get('crm') ? `Summarize the CRM ${params.get('crm_kind') ?? 'record'} ${params.get('crm')} and suggest a next step.` : '';
  const [message, setMessage] = useState(initial);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [following, setFollowing] = useState<string | null>(null);
  const [stream, setStream] = useState('');
  const [progress, setProgress] = useState('');
  const [liveTeam, setLiveTeam] = useState<LiveTask[]>([]);
  const [settings, setSettings] = useState(false);
  const [sources, setSources] = useState<string[]>(params.get('source') ? [params.get('source')!] : []);
  const [picker, setPicker] = useState(false);
  const mounted = useRef(true);
  const requestKey = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const timeline = useQuery({
    queryKey: [...base, 'timeline', conversationId],
    queryFn: () => result(platform.rpc('agent_conversation_timeline', { p_conversation_id: conversationId! })),
    enabled: !!conversationId,
    refetchInterval: following || sending ? false : 4000,
    staleTime: 0,
  });
  const activity = useQuery({
    queryKey: [...base, 'activity', conversationId],
    enabled: !!conversationId,
    refetchInterval: following || sending ? 2000 : 5000,
    queryFn: async () => {
      const runs = await result(
        platform.from('agent_runs').select('*').eq('conversation_id', conversationId!).order('created_at', { ascending: false }).limit(40),
      );
      const top = runs.filter((r) => !r.parent_run_id);
      const [proposals, citations, events, tasks] = await Promise.all([
        result(platform.from('agent_action_proposals').select('*').eq('conversation_id', conversationId!).order('created_at')),
        runs.length ? result(platform.from('agent_citations').select('*').in('run_id', runs.map((r) => r.id))) : Promise.resolve([]),
        top[0] ? result(platform.from('agent_run_events').select('*').eq('run_id', top[0].id).order('id').limit(80)) : Promise.resolve([]),
        top[0] ? result(platform.from('agent_team_tasks').select('*').eq('parent_run_id', top[0].id).order('ordinal')) : Promise.resolve([]),
      ]);
      return { runs, top, proposals, citations, events, tasks };
    },
  });
  const files = useQuery({
    queryKey: ['platform', ws, userId, 'agent-source-options'],
    enabled: picker,
    queryFn: () => result(platform.rpc('drive_list', { p_workspace_id: ws, p_view: 'all', p_limit: 100 })),
  });
  const notes = useQuery({
    queryKey: [...base, 'notes', agent?.id],
    enabled: agent?.template_key === 'personal_coach',
    queryFn: () =>
      result(platform.from('agent_personal_notes').select('id, content, created_at').eq('agent_id', agent!.id).order('created_at', { ascending: false })),
  });

  const refresh = () => cache.invalidateQueries({ queryKey: base });
  const running = activity.data?.top.find((r) => ['running', 'queued'].includes(r.status));
  const { blocking, notes: limits } = agent ? readiness(agent, props.status) : { blocking: ['This agent was retired.'], notes: [] };
  const available = !blocking.length;
  const isTeam = agent?.kind === 'coordinator';
  const agentsById = new Map(props.directory.map((x) => [x.id, x]));

  async function handle(name: string, data: Record<string, unknown>) {
    if (!mounted.current) return;
    if (name === 'run') {
      requestKey.current = null;
      setMessage('');
      setFollowing(String(data.run_id));
      if (!conversationId) navigate(`/agents/conversations/${data.conversation_id}${params.toString() ? `?${params}` : ''}`, { replace: true });
      await refresh();
    } else if (name === 'snapshot') setStream(String(data.text ?? ''));
    else if (name === 'tool' && data.label) setProgress(String(data.label));
    else if (name === 'team') setLiveTeam((data.tasks as LiveTask[]) ?? []);
    else if (name === 'warning' && data.message) setProgress(String(data.message));
    else if (name === 'done') {
      setProgress('');
      if (data.error_message) setError(String(data.error_message));
    }
  }

  // Reattach to a run that is still in progress (refresh, another tab, a dropped connection).
  useEffect(() => {
    if (!running || sending || following === running.id) return;
    let cancelled = false;
    setFollowing(running.id);
    void (async () => {
      try {
        const response = await api(`agents/run?run_id=${running.id}`);
        await consumeEvents(response, (n, d) => (cancelled ? undefined : handle(n, d)));
      } catch {
        /* polling below keeps the view current */
      } finally {
        if (!cancelled && mounted.current) {
          setFollowing(null);
          setStream('');
          setLiveTeam([]);
          await refresh();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running?.id, sending]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!agent || !message.trim()) return;
    setSending(true);
    setError('');
    setStream('');
    setLiveTeam([]);
    setProgress('Starting…');
    requestKey.current ??= crypto.randomUUID();
    try {
      const response = await api('agents/run', {
        workspace_id: ws,
        agent_id: agent.id,
        conversation_id: conversationId ?? null,
        message,
        scope: {
          item_ids: sources,
          ...(params.get('channel') ? { channel_id: params.get('channel') } : {}),
          ...(params.get('thread') ? { thread_root_id: params.get('thread') } : {}),
        },
        origin: { type: params.get('source') ? 'drive' : params.get('channel') ? 'channel' : 'agents' },
        idempotency_key: requestKey.current,
      });
      await consumeEvents(response, handle);
    } catch (err) {
      if (mounted.current) setError(`${errorText(err)} Your conversation is saved; reopen it to see the run’s status before retrying.`);
    } finally {
      if (mounted.current) {
        setSending(false);
        setFollowing(null);
        setStream('');
        setLiveTeam([]);
        await refresh();
      }
    }
  }

  async function action(fn: () => PromiseLike<unknown>) {
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const tasks: LiveTask[] = liveTeam.length
    ? liveTeam
    : (activity.data?.tasks ?? []).map((t) => {
        const child = activity.data?.runs.find((r) => r.id === t.child_run_id);
        return { task_id: t.id, agent: agentsById.get(t.agent_id)?.name ?? 'Specialist', status: child?.status ?? t.status };
      });
  const liveMessageId = stream ? activity.data?.top[0]?.output_message_id : undefined;
  const toolNames = agent?.tools ?? [];
  const toolInfo = (name: string) => props.status?.tools.find((t) => t.name === name);

  return (
    <>
      <header className={s.header}>
        <div className={a.cardTop}>
          {agent && <Avatar agent={agent} />}
          <div>
            <div className={s.eyebrow}>{isTeam ? 'Team Chat' : (agent?.job ?? 'Agent')}</div>
            <h1>{isTeam ? 'Ask the whole team' : (agent?.name ?? 'Conversation')}</h1>
            <p className={s.muted}>{agent ? agent.capability : 'This agent was retired. The conversation stays available to read.'}</p>
          </div>
        </div>
        <div className={s.actions}>
          <Link className={s.button} to="/agents">All agents</Link>
          {agent && (props.admin || agent.created_by === userId) && !isTeam && (
            <button className={s.button} onClick={() => setSettings(true)}>Agent settings</button>
          )}
          {props.admin && <button className={s.button} onClick={props.onOpenAiSettings} disabled={!props.status}>AI settings</button>}
        </div>
      </header>
      {props.notice}
      {(error || timeline.error || activity.error) && (
        <p className={s.error} role="alert">{error || errorText(timeline.error ?? activity.error)}</p>
      )}
      <div className={a.layout}>
        <div className={s.conversation} style={{ margin: 0, maxWidth: 'none' }}>
          <div className={s.actions}>
            <span className={s.pill}>Private · only you</span>
            {params.get('channel') && <span className={s.pill}>{params.get('thread') ? 'About a thread' : 'About a channel'}</span>}
            {agent && (
              <button className={s.button} onClick={() => setPicker(true)}>
                {sources.length ? `${sources.length} selected source(s)` : 'Choose Drive sources'}
              </button>
            )}
          </div>
          {!conversationId && agent && (
            <div className={s.empty}>
              <h2>{isTeam ? 'What should the team work on?' : `How can ${agent.name} help?`}</h2>
              <p>{agent.description}</p>
              <div className={s.stack}>
                {agent.examples.map((ex) => (
                  <button key={ex} className={s.button} onClick={() => setMessage(ex)}>{ex}</button>
                ))}
              </div>
            </div>
          )}
          {timeline.data?.map((m) => (
            <TimelineMessage
              key={m.id}
              m={m}
              agent={agentsById.get(m.agent_id ?? '')}
              text={m.id === liveMessageId ? stream : m.content}
              citations={activity.data?.citations.filter((c) => c.message_id === m.id) ?? []}
            />
          ))}
          {sending && stream && !liveMessageId && (
            <article className={s.message} aria-live="polite"><Markdown text={stream} /></article>
          )}
          {tasks.length > 0 && (
            <section aria-label="Team tasks" className={a.team}>
              <div className={s.eyebrow}>Team tasks</div>
              {tasks.map((t) => (
                <div key={t.task_id} className={a.task}>
                  <span>{t.agent}</span>
                  <span>{t.status === 'awaiting_approval' ? 'done · review needed' : t.status}</span>
                </div>
              ))}
            </section>
          )}
          {(sending || running) && <p role="status" className={s.muted}>{progress || 'Working…'}</p>}
          {activity.data?.proposals.map((p) => <Proposal key={p.id} proposal={p} onChange={refresh} />)}
          {activity.data?.top[0] && (
            <details className={s.notice}>
              <summary>
                Run activity · {activity.data.top[0].status}
                {activity.data.top[0].served_model ? ` · ${activity.data.top[0].served_model}` : ''}
              </summary>
              {activity.data.top[0].error_message && <p>{activity.data.top[0].error_message}</p>}
              {activity.data.events.map((e) => {
                const d = (e.data ?? {}) as Record<string, unknown>;
                return (
                  <p key={e.id}>
                    {new Date(e.created_at).toLocaleTimeString()} · {String(d.label ?? d.message ?? e.type)}
                    {d.status ? ` (${String(d.status)})` : ''}
                  </p>
                );
              })}
            </details>
          )}
          {agent && (
            <form className={s.form} onSubmit={send}>
              <label>
                {isTeam ? 'Message the team' : `Message ${agent.name}`}
                <textarea
                  className={s.text}
                  placeholder={isTeam ? 'Describe the goal; the team lead assigns the work…' : 'Ask a question, request a draft, or plan your next step…'}
                  value={message}
                  onChange={(e) => {
                    setMessage(e.target.value);
                    requestKey.current = null;
                  }}
                  maxLength={20000}
                  required
                  disabled={sending}
                />
              </label>
              <div className={s.actions}>
                <button className={s.primary} disabled={!available || sending || !!running || !message.trim()}>Send</button>
                {running && (
                  <button type="button" className={s.button} onClick={() => void action(() => result(platform.rpc('agent_cancel_run', { p_run_id: running.id })))}>
                    Stop
                  </button>
                )}
                <span className={s.muted}>{blocking[0] ?? 'Actions wait for your review before anything changes.'}</span>
              </div>
            </form>
          )}
        </div>
        <aside className={a.side}>
          {agent && (
            <section>
              <h3>Readiness</h3>
              <ul>
                {blocking.map((b) => (
                  <li key={b} className={a.state}><span className={`${a.dot} ${a.blocked}`} />{b}</li>
                ))}
                {limits.map((n) => (
                  <li key={n} className={a.state}><span className={`${a.dot} ${a.limited}`} />{n}</li>
                ))}
                {!blocking.length && !limits.length && (
                  <li className={a.state}><span className={`${a.dot} ${a.ready}`} />Ready, with everything it can use.</li>
                )}
              </ul>
            </section>
          )}
          {agent && (
            <section>
              <h3>What {isTeam ? 'the team lead' : agent.name} can do</h3>
              <ul>
                {toolNames.map((name) => {
                  const info = toolInfo(name);
                  return (
                    <li key={name}>
                      {TOOL_LABELS[name] ?? name}
                      {info?.approval === 'review_card' ? <span className={s.muted}> · needs your approval</span> : null}
                      {info && !info.available ? <span className={s.muted}> · unavailable: {info.reason}</span> : null}
                    </li>
                  );
                })}
              </ul>
              {!isTeam && <p className={a.handle}>Mention @{agent.handle} in a channel for a reply in the thread.</p>}
            </section>
          )}
          {agent?.template_key === 'personal_coach' && (
            <section>
              <h3>Your private notes</h3>
              <p className={s.muted}>Only you can see these. They are never used to answer anyone else.</p>
              <ul>
                {notes.data?.map((n) => (
                  <li key={n.id} className={a.note}>
                    <span>{n.content}</span>
                    <button
                      className={a.linkButton}
                      onClick={() => void action(() => result(platform.from('agent_personal_notes').delete().eq('id', n.id)))}
                    >
                      Delete
                    </button>
                  </li>
                ))}
                {notes.data && !notes.data.length && <li className={s.muted}>Ask {agent.name} to remember something.</li>}
              </ul>
            </section>
          )}
          <section>
            <h3>Conversations</h3>
            <ul>
              {props.conversations.slice(0, 12).map((c) => (
                <li key={c.id}>
                  <Link className={s.link} to={`/agents/conversations/${c.id}`} aria-current={c.id === conversationId ? 'page' : undefined}>
                    {c.title}
                  </Link>
                </li>
              ))}
              {!props.conversations.length && <li className={s.muted}>None yet.</li>}
            </ul>
            {conversationId && agent && (
              <p><Link className={s.button} to={isTeam ? '/agents/team' : `/agents/${agent.id}`}>New conversation</Link></p>
            )}
          </section>
        </aside>
      </div>
      <Dialog open={picker} onClose={() => setPicker(false)} title="Choose sources">
        <div className={s.form}>
          <p className={s.muted}>Without a selection, agents search everything their configuration permits that you can open.</p>
          {files.error && <p role="alert">{errorText(files.error)}</p>}
          <div className={a.picker}>
            {files.data?.filter((f) => f.kind !== 'folder').map((f) => (
              <label key={f.id}>
                <input
                  type="checkbox"
                  checked={sources.includes(f.id)}
                  onChange={(e) => setSources((v) => (e.target.checked ? [...v, f.id].slice(0, 20) : v.filter((id) => id !== f.id)))}
                />
                {f.name}
              </label>
            ))}
          </div>
          <button className={s.primary} onClick={() => setPicker(false)}>Use selected sources</button>
        </div>
      </Dialog>
      {agent && settings && <AgentSettings agent={agent} models={props.status?.settings.allowed_models ?? [agent.model]} onClose={() => setSettings(false)} onSaved={refresh} />}
    </>
  );
}

function TimelineMessage({ m, agent, text, citations }: { m: TimelineRow; agent: Agent | undefined; text: string; citations: Row<'agent_citations'>[] }) {
  const who = m.agent_name ?? 'Agent';
  if (m.kind === 'delegation') {
    return (
      <div className={a.delegation}>
        <div className={a.author}>
          {agent && <Avatar agent={agent} small />}
          {m.role === 'user' ? `Task for ${who}` : `${who} · ${m.status === 'streaming' ? 'working…' : m.status}`}
        </div>
        {m.role === 'user' ? m.content : text ? <Markdown text={text} /> : 'Working…'}
        <Citations items={m.redacted ? [] : citations} />
      </div>
    );
  }
  return (
    <article className={`${s.message} ${m.role === 'user' ? s.user : ''}`}>
      <div className={s.eyebrow}>{m.role === 'user' ? 'You' : `${who} · ${m.status === 'streaming' ? 'working…' : m.status}`}</div>
      {m.role === 'user' ? m.content : text ? <Markdown text={text} /> : m.status === 'streaming' ? 'Working…' : ''}
      <Citations items={m.redacted ? [] : citations} />
    </article>
  );
}

function Citations({ items }: { items: Row<'agent_citations'>[] }) {
  if (!items.length) return null;
  return (
    <>
      {items.map((c) => {
        const loc = typeof c.location === 'object' && c.location && !Array.isArray(c.location) ? c.location : {};
        const version = c.version_id ? `version=${c.version_id}&` : c.revision_id ? `revision=${c.revision_id}&` : '';
        return (
          <p key={c.id}>
            <Link className={s.link} to={`/drive/item/${c.item_id}?${version}page=${typeof loc.page === 'number' ? loc.page : 1}`}>
              [{c.ordinal}] Open source
            </Link>
            {c.quote && <small className={s.muted}> — {c.quote}</small>}
          </p>
        );
      })}
    </>
  );
}

function Proposal({ proposal: p, onChange }: { proposal: Row<'agent_action_proposals'>; onChange: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const args = p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? p.arguments : {};
  const output = p.result && typeof p.result === 'object' && !Array.isArray(p.result) ? p.result : {};
  async function decide(approve: boolean) {
    setBusy(true);
    setError('');
    try {
      await result(platform.rpc('agent_decide_proposal', { p_proposal_id: p.id, p_approve: approve, p_arguments_hash: p.arguments_hash }));
      await onChange();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={s.card}>
      <div className={s.eyebrow}>Review action · {p.status}</div>
      <h2>{p.summary}</h2>
      {Object.entries(args).map(([k, v]) => (
        <div key={k}>
          <strong className={s.muted}>{k.replaceAll('_', ' ')}</strong>
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{typeof v === 'string' ? v : JSON.stringify(v)}</p>
        </div>
      ))}
      {error && <p role="alert" className={s.error}>{error}</p>}
      {p.status === 'pending' && (
        <div className={s.actions}>
          <button className={s.primary} disabled={busy} onClick={() => void decide(true)}>Approve</button>
          <button className={s.button} disabled={busy} onClick={() => void decide(false)}>Reject</button>
          <span className={s.muted}>Expires {new Date(p.expires_at).toLocaleString()}</span>
        </div>
      )}
      {typeof output.item_id === 'string' && <Link to={`/drive/item/${output.item_id}`}>Open saved document</Link>}
      {typeof output.link === 'string' && output.link.startsWith('/crm/') && <Link to={output.link}>Open updated record</Link>}
      {typeof output.task_id === 'string' && <Link to={`/tasks/${output.task_id}`}>Open created task</Link>}
      {typeof output.event_id === 'string' && <Link to="/calendar">Open calendar</Link>}
      {p.error && <p role="alert" className={s.error}>{p.error}</p>}
    </section>
  );
}

function AgentSettings({ agent, models, onClose, onSaved }: { agent: Agent; models: string[]; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [error, setError] = useState('');
  const [instructions, setInstructions] = useState('');
  const [model, setModel] = useState(agent.model);
  const [busy, setBusy] = useState(false);
  const config = useQuery({
    queryKey: ['platform', agent.id, 'config'],
    queryFn: () => result(platform.from('workspace_agent_versions').select('*').eq('agent_id', agent.id).order('version_no', { ascending: false }).limit(1).single()),
  });
  useEffect(() => {
    if (config.data) setInstructions(config.data.instructions);
  }, [config.data]);
  function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    void result(platform.rpc('agent_save_config', { p_agent_id: agent.id, p_config: { instructions, model, tools: agent.tools, source_scope: agent.source_scope } }))
      .then(async () => {
        await onSaved();
        onClose();
      })
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(false));
  }
  return (
    <Dialog open onClose={onClose} title={`${agent.name} settings`}>
      <form className={s.form} onSubmit={save}>
        <p className={s.muted}>Saving creates a new configuration version. Earlier runs keep the version they used.</p>
        <label>
          Model
          <select className={s.input} value={model} onChange={(e) => setModel(e.target.value)}>
            {[...new Set([agent.model, ...models])].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          Instructions
          <textarea className={s.text} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={20000} />
        </label>
        <p className={s.muted}>Tools: {agent.tools.map((t) => TOOL_LABELS[t] ?? t).join(' · ')}. Changes to data always need review.</p>
        {(error || config.error) && <p role="alert" className={s.error}>{error || errorText(config.error)}</p>}
        <button className={s.primary} disabled={busy || !config.data}>Save new version</button>
      </form>
    </Dialog>
  );
}

function AiSettings({ ws, status, onClose, onSaved }: { ws: string; status: Status; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    enabled: status.settings.enabled,
    default_model: status.settings.default_model,
    web_research_enabled: status.settings.web_research_enabled,
    mention_reply_policy: status.settings.mention_reply_policy,
    site_url: status.site.url ?? '',
    brand_kit_folder_id: status.brand_kit.folder_id ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const folders = useQuery({
    queryKey: ['platform', ws, 'ai-settings-folders'],
    queryFn: async () => (await result(platform.rpc('drive_list', { p_workspace_id: ws, p_view: 'all', p_limit: 200 }))).filter((f) => f.kind === 'folder'),
  });
  function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    void result(platform.rpc('ai_update_settings', { p_workspace_id: ws, p_patch: { ...form, site_url: form.site_url.trim(), brand_kit_folder_id: form.brand_kit_folder_id || null } }))
      .then(() => {
        onSaved();
        onClose();
      })
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(false));
  }
  return (
    <Dialog open onClose={onClose} title="AI settings">
      <form className={s.form} onSubmit={save}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          AI is enabled for this workspace
        </label>
        <label>
          Default model for new agents
          <select className={s.input} value={form.default_model} onChange={(e) => setForm({ ...form, default_model: e.target.value })}>
            {status.settings.allowed_models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          Brand kit folder (voice, tone and visual rules for writing agents)
          <select className={s.input} value={form.brand_kit_folder_id} onChange={(e) => setForm({ ...form, brand_kit_folder_id: e.target.value })}>
            <option value="">None</option>
            {folders.data?.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
        <label>
          Site address for the SEO specialist (https only)
          <input className={s.input} type="url" placeholder="https://www.example.com" value={form.site_url} onChange={(e) => setForm({ ...form, site_url: e.target.value })} />
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={form.web_research_enabled} onChange={(e) => setForm({ ...form, web_research_enabled: e.target.checked })} />
          Allow web research (results are attributed and treated as untrusted)
        </label>
        <label>
          Replies when someone mentions an agent in a conversation
          <select className={s.input} value={form.mention_reply_policy} onChange={(e) => setForm({ ...form, mention_reply_policy: e.target.value })}>
            <option value="review">The person who mentioned it reviews the reply first</option>
            <option value="auto">Post automatically when everyone in the conversation can open its sources</option>
          </select>
        </label>
        <div>
          <div className={s.eyebrow}>Provider and data flow</div>
          <p className={s.muted}>{status.data_flow.generation}</p>
          <p className={s.muted}>{status.data_flow.embeddings}</p>
          <p className={s.muted}>{status.data_flow.storage}</p>
        </div>
        <div>
          <div className={s.eyebrow}>Connections</div>
          <p className={s.muted}>Connections add actions such as sending email or publishing posts. None is simulated: each needs an authorized integration on the server.</p>
          <ul className={a.picker} style={{ listStyle: 'none', padding: 0 }}>
            {status.connectors.map((c) => (
              <li key={c.kind} className={a.state}>
                <span className={`${a.dot} ${c.status === 'connected' ? a.ready : a.limited}`} />
                {c.label} · {c.status === 'connected' ? 'connected' : 'not connected'}
              </li>
            ))}
          </ul>
        </div>
        {error && <p role="alert" className={s.error}>{error}</p>}
        <button className={s.primary} disabled={busy}>Save settings</button>
      </form>
    </Dialog>
  );
}
