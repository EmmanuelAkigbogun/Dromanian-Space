import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { useAuth } from '@/hooks/useAuth';
import { useProfileContext } from '@/app/providers/ProfileProvider';
import { platform, result, errorText } from '@/features/platform/client';
import { getProfilesByUserIds } from '@/lib/profile';
import { Avatar } from '@/components/ui/Avatar';
import { ThroughputChart, type ThroughputWeek } from '@/components/dashboard/ThroughputChart/ThroughputChart';
import { formatRelativeTime } from '@/utils';
import styles from './Home.module.css';

interface Dashboard {
  tasks: number;
  projects: number;
  members: number;
  approvals: number;
  notifications: number;
  recent_files: Array<{ id: string; name: string; kind: string }>;
  conversations: Array<{ id: string; title: string }>;
  recent_tasks: Array<{ id: string; title: string; status: string }>;
}

interface Insights {
  throughput: ThroughputWeek[];
  completed_tasks: number;
  open_tasks: number;
  projects: Array<{ id: string; name: string; color: string | null; due_date: string | null; total: number; done: number; member_ids: string[] }>;
  activity: Array<{ id: string; title: string; message: string; link: string | null; actor_id: string | null; created_at: string; read: boolean }>;
}

const icon = (d: string) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const ICONS = {
  bell: icon('M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0'),
  review: icon('M9 11l3 3 8-8M20 12v7a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2h9'),
  tasks: icon('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'),
  projects: icon('M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z'),
};

const STATUS_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  review: 'In review',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function Card({ title, description, action, children, className }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`${styles.card} ${className ?? ''}`}>
      <header className={styles.cardHeader}>
        <div>
          <h2 className={styles.cardTitle}>{title}</h2>
          {description && <p className={styles.cardDescription}>{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Home() {
  const { currentWorkspace } = useWorkspaceContext();
  const { userId } = useAuth();
  const { profile } = useProfileContext();
  const ws = currentWorkspace!.id;
  const base = ['platform', ws, userId, 'home'];

  const data = useQuery({
    queryKey: [...base, 'dashboard'],
    queryFn: async () => (await result(platform.rpc('workspace_dashboard', { p_workspace_id: ws }))) as Dashboard,
    staleTime: 10000,
    refetchInterval: 30000,
  });
  const insights = useQuery({
    queryKey: [...base, 'insights'],
    queryFn: async () => (await result(platform.rpc('workspace_dashboard_insights', { p_workspace_id: ws }))) as Insights,
    staleTime: 30000,
    refetchInterval: 60000,
  });
  const pending = useQuery({
    queryKey: [...base, 'task-requests'],
    queryFn: async () => {
      const { count } = await platform.from('task_requests').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('status', 'pending');
      return count ?? 0;
    },
    staleTime: 30000,
  });
  const agents = useQuery({
    queryKey: ['platform', ws, userId, 'agents', 'directory'],
    queryFn: () => result(platform.rpc('agent_directory', { p_workspace_id: ws })),
    staleTime: 60000,
  });
  const peopleIds = [
    ...new Set([...(insights.data?.projects.flatMap((p) => p.member_ids) ?? []), ...(insights.data?.activity.map((a) => a.actor_id).filter((id): id is string => !!id) ?? [])]),
  ];
  const people = useQuery({
    queryKey: [...base, 'people', peopleIds.join(',')],
    queryFn: () => getProfilesByUserIds(peopleIds),
    enabled: peopleIds.length > 0,
    staleTime: 300000,
  });
  const person = (id: string | null) => people.data?.find((p) => p.id === id);

  const firstName = profile?.display_name?.split(' ')[0] || profile?.username || 'there';
  const toReview = (data.data?.approvals ?? 0) + (pending.data ?? 0);
  const stats = [
    { label: 'Unread activity', value: data.data?.notifications, hint: 'Mentions, assignments and updates', to: '/notifications', icon: ICONS.bell },
    { label: 'Waiting for review', value: data.isPending ? undefined : toReview, hint: 'Agent proposals and task approvals', to: pending.data ? '/tasks?view=approvals' : '/agents', icon: ICONS.review },
    { label: 'Open tasks', value: insights.data?.open_tasks, hint: `${insights.data?.completed_tasks ?? '—'} completed so far`, to: '/tasks', icon: ICONS.tasks },
    { label: 'Active projects', value: data.data?.projects, hint: `${data.data?.members ?? '—'} people in the workspace`, to: '/projects', icon: ICONS.projects },
  ];

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>
            {currentWorkspace!.name} · {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          <h1 className={styles.title}>Welcome back, {firstName}</h1>
        </div>
        <div className={styles.heroActions}>
          <Link className={styles.secondaryButton} to="/channels">Open chat</Link>
          <Link className={styles.primaryButton} to="/tasks">New task</Link>
        </div>
      </header>

      {(data.error || insights.error) && (
        <p role="alert" className={styles.error}>
          {errorText(data.error ?? insights.error)}{' '}
          <button type="button" onClick={() => { void data.refetch(); void insights.refetch(); }}>Retry</button>
        </p>
      )}

      <div className={styles.stats}>
        {stats.map((s) => (
          <Link key={s.label} to={s.to} className={styles.stat}>
            <div className={styles.statTop}>
              <span className={styles.statLabel}>{s.label}</span>
              <span className={styles.statIcon}>{s.icon}</span>
            </div>
            <span className={styles.statValue}>{s.value ?? '—'}</span>
            <span className={styles.statHint}>{s.hint}</span>
          </Link>
        ))}
      </div>

      <Card title="Task throughput" description="Tasks opened and completed per week, over the last eight weeks">
        {insights.data ? (
          insights.data.throughput.some((w) => w.opened || w.completed) ? (
            <ThroughputChart weeks={insights.data.throughput} />
          ) : (
            <div className={styles.empty}>No task activity in the last eight weeks yet. <Link to="/tasks">Create a task</Link></div>
          )
        ) : (
          <div className={styles.skeletonChart} aria-hidden="true" />
        )}
      </Card>

      <div className={styles.split}>
        <Card title="Active projects" description="Progress by completed tasks" action={<Link className={styles.cardLink} to="/projects">All projects</Link>}>
          {insights.data?.projects.length ? (
            <ul className={styles.projects}>
              {insights.data.projects.map((p) => {
                const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
                return (
                  <li key={p.id}>
                    <Link to={`/projects/${p.id}`} className={styles.project}>
                      <div className={styles.projectTop}>
                        <span className={styles.projectName}>
                          <span className={styles.projectDot} style={{ background: p.color ?? 'var(--color-primary)' }} aria-hidden="true" />
                          {p.name}
                        </span>
                        <span className={styles.projectCount}>{p.done}/{p.total} tasks</span>
                      </div>
                      <div className={styles.progressRow}>
                        <div className={styles.progress} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.name} progress`}>
                          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
                        </div>
                        <span className={styles.progressValue}>{pct}%</span>
                      </div>
                      <div className={styles.projectBottom}>
                        <span className={styles.faces}>
                          {p.member_ids.map((id) => {
                            const who = person(id);
                            return <Avatar key={id} size="xs" src={who?.avatar_url ?? undefined} name={who?.display_name || who?.username || '?'} className={styles.face} />;
                          })}
                        </span>
                        {p.due_date && <span className={styles.muted}>Due {new Date(p.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className={styles.empty}>{insights.isPending ? 'Loading…' : <>No active projects. <Link to="/projects">Start one</Link></>}</div>
          )}
        </Card>

        <Card title="Recent activity" description="Latest updates for you" action={<Link className={styles.cardLink} to="/notifications">View all</Link>}>
          {insights.data?.activity.length ? (
            <ol className={styles.activity}>
              {insights.data.activity.map((a) => {
                const who = person(a.actor_id);
                const body = (
                  <>
                    <Avatar size="sm" src={who?.avatar_url ?? undefined} name={who?.display_name || who?.username || a.title} />
                    <div className={styles.activityText}>
                      <p className={styles.activityTitle}>
                        {!a.read && <span className={styles.unreadDot} aria-label="Unread" />}
                        {a.title}
                      </p>
                      <p className={styles.activityMessage}>{a.message}</p>
                      <p className={styles.activityTime}>{formatRelativeTime(a.created_at)}</p>
                    </div>
                  </>
                );
                return (
                  <li key={a.id}>
                    {a.link?.startsWith('/') ? <Link to={a.link} className={styles.activityItem}>{body}</Link> : <div className={styles.activityItem}>{body}</div>}
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className={styles.empty}>{insights.isPending ? 'Loading…' : 'Nothing new. Assignments, mentions and approvals will show up here.'}</div>
          )}
        </Card>
      </div>

      <div className={styles.split}>
        <Card title="Pick up where you left off">
          <ul className={styles.list}>
            {data.data?.recent_tasks.map((t) => (
              <li key={t.id}>
                <Link to={`/tasks/${t.id}`} className={styles.listItem}>
                  <span className={styles.listGlyph}>{ICONS.tasks}</span>
                  <span className={styles.listLabel}>{t.title}</span>
                  <span className={styles.status} data-status={t.status}>{STATUS_LABELS[t.status] ?? t.status}</span>
                </Link>
              </li>
            ))}
            {data.data?.recent_files.map((f) => (
              <li key={f.id}>
                <Link to={`/drive/${f.kind === 'folder' ? 'folder' : 'item'}/${f.id}`} className={styles.listItem}>
                  <span className={styles.listGlyph}>{ICONS.projects}</span>
                  <span className={styles.listLabel}>{f.name}</span>
                  <span className={styles.muted}>Recently opened</span>
                </Link>
              </li>
            ))}
            {data.data?.conversations.map((c) => (
              <li key={c.id}>
                <Link to={`/agents/conversations/${c.id}`} className={styles.listItem}>
                  <span className={styles.listGlyph}>✦</span>
                  <span className={styles.listLabel}>{c.title}</span>
                  <span className={styles.muted}>Agent chat</span>
                </Link>
              </li>
            ))}
          </ul>
          {data.data && !data.data.recent_tasks.length && !data.data.recent_files.length && !data.data.conversations.length && (
            <div className={styles.empty}>Tasks, files and agent chats you open will appear here.</div>
          )}
        </Card>

        <Card title="Your AI team" description="Specialists that work with what you can access" action={<Link className={styles.cardLink} to="/agents">All agents</Link>}>
          <ul className={styles.agents}>
            {agents.data?.filter((a) => a.kind === 'specialist').slice(0, 5).map((a) => (
              <li key={a.id}>
                <Link to={`/agents/${a.id}`} className={styles.agent}>
                  <span className={styles.agentBadge} style={{ background: a.color }}>{a.name[0]}</span>
                  <span className={styles.agentText}>
                    <span className={styles.agentName}>{a.name}</span>
                    <span className={styles.agentJob}>{a.job}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
