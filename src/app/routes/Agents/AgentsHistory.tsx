// History: every past conversation with an agent or the team, newest first,
// grouped by day, searchable, with rename and delete.
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { useAuth } from '@/hooks/useAuth';
import { platform } from '@/lib/platform';
import { useToast } from '@/components/ui/Toast';
import styles from './AgentsHistory.module.css';

interface Conversation { id: string; agent_id: string; title: string; last_message_at: string; created_at: string }
interface Preview { conversation_id: string; role: string; content: string }

type Rpc = { rpc: (f: string, a: Record<string, unknown>) => Promise<{ error: { message: string } | null }> };

function groupOf(iso: string): string {
  const d = new Date(iso);
  const today = new Date(new Date().toDateString()).getTime();
  const t = new Date(d.toDateString()).getTime();
  if (t === today) return 'Today';
  if (t === today - 864e5) return 'Yesterday';
  if (t > today - 7 * 864e5) return 'Previous 7 days';
  if (t > today - 30 * 864e5) return 'Previous 30 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export default function AgentsHistory() {
  const { currentWorkspace } = useWorkspaceContext();
  const { userId } = useAuth();
  const ws = currentWorkspace!.id;
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const key = ['platform', ws, userId, 'agents', 'history'];

  const data = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data: conversations } = await platform.from('agent_conversations').select('id,agent_id,title,last_message_at,created_at')
        .eq('workspace_id', ws).is('archived_at', null).order('last_message_at', { ascending: false }).limit(300);
      const list = (conversations ?? []) as Conversation[];
      const agentIds = [...new Set(list.map((c) => c.agent_id))];
      const [agents, messages] = await Promise.all([
        agentIds.length ? platform.from('workspace_agents').select('id,name,kind').in('id', agentIds) : Promise.resolve({ data: [] }),
        list.length ? platform.from('agent_messages').select('conversation_id,role,content').in('conversation_id', list.slice(0, 150).map((c) => c.id))
          .order('created_at', { ascending: false }).limit(1500) : Promise.resolve({ data: [] }),
      ]);
      const names = new Map(((agents.data ?? []) as { id: string; name: string; kind: string }[]).map((a) => [a.id, a]));
      const previews = new Map<string, Preview>();
      for (const m of (messages.data ?? []) as Preview[]) if (!previews.has(m.conversation_id) && m.content) previews.set(m.conversation_id, m);
      return list.map((c) => ({ ...c, agent: names.get(c.agent_id) ?? null, preview: previews.get(c.id) ?? null }));
    },
  });

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = (data.data ?? []).filter((c) => !q || c.title.toLowerCase().includes(q) || (c.agent?.name ?? '').toLowerCase().includes(q) || (c.preview?.content ?? '').toLowerCase().includes(q));
    const out: { label: string; rows: typeof rows }[] = [];
    for (const r of rows) {
      const label = groupOf(r.last_message_at);
      if (out.at(-1)?.label !== label) out.push({ label, rows: [] });
      out.at(-1)!.rows.push(r);
    }
    return out;
  }, [data.data, search]);

  const call = async (fn: string, args: Record<string, unknown>, done: string) => {
    const { error } = await (platform as unknown as Rpc).rpc(fn, args);
    if (error) toast({ variant: 'error', description: error.message });
    else { toast({ variant: 'success', description: done }); await cache.invalidateQueries({ queryKey: ['platform', ws, userId, 'agents'] }); }
  };

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div>
          <h1>History</h1>
          <p className={styles.muted}>Your past conversations with agents and the team. Only you can see them.</p>
        </div>
        <div className={styles.actions}>
          <Link className={styles.button} to="/agents">All agents</Link>
          <Link className={styles.primary} to="/agents/team">New team chat</Link>
        </div>
      </header>
      <label className={styles.search}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></svg>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search conversations" aria-label="Search conversations" />
      </label>

      {data.isPending && <p className={styles.muted}>Loading…</p>}
      {data.data && !data.data.length && <div className={styles.empty}>No conversations yet. Start one from <Link to="/agents">All agents</Link>.</div>}
      {data.data && data.data.length > 0 && !groups.length && <div className={styles.empty}>Nothing matches “{search}”.</div>}

      {groups.map((g) => (
        <section key={g.label} className={styles.group}>
          <h2>{g.label}</h2>
          <ul>
            {g.rows.map((c) => (
              <li key={c.id} className={styles.row}>
                <button type="button" className={styles.open} onClick={() => navigate(`/agents/conversations/${c.id}`)}>
                  <span className={styles.avatar} aria-hidden="true">{(c.agent?.name ?? '?').slice(0, 1).toUpperCase()}</span>
                  <span className={styles.text}>
                    <strong>{c.title || 'Untitled conversation'}</strong>
                    <span className={styles.meta}>{c.agent?.kind === 'coordinator' ? 'Team chat' : c.agent?.name ?? 'Retired agent'} · {new Date(c.last_message_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    {c.preview && <span className={styles.preview}>{c.preview.role === 'user' ? 'You: ' : ''}{c.preview.content.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').slice(0, 160)}</span>}
                  </span>
                </button>
                <span className={styles.rowActions}>
                  <button type="button" onClick={() => {
                    const title = window.prompt('Rename conversation', c.title);
                    if (title && title.trim() && title.trim() !== c.title) void call('agent_conversation_rename', { p_conversation_id: c.id, p_title: title.trim() }, 'Renamed.');
                  }}>Rename</button>
                  <button type="button" className={styles.danger} onClick={() => {
                    if (window.confirm(`Delete “${c.title || 'this conversation'}” from your history?`)) void call('agent_conversation_archive', { p_conversation_id: c.id }, 'Conversation deleted.');
                  }}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
