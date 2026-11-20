// The GitHub project agent in the app: connect a read-only token, turn a
// repository into a project, and see / run a linked project's weekly review.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/features/platform/client';
import { platform } from '@/lib/platform';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import styles from './GithubProjects.module.css';

interface Status { connected: boolean; login: string | null; connected_at: string | null }
interface Repo { full_name: string; description: string | null; private: boolean; default_branch: string; html_url: string; pushed_at: string; open_issues_count: number }

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const res = await api('github', body);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message ?? data?.error ?? 'GitHub request failed');
  return data as T;
}

const GithubMark = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.mark}>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

export function useGithubStatus(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['github-status', workspaceId],
    enabled: !!workspaceId,
    staleTime: 60_000,
    queryFn: async (): Promise<Status> => {
      const res = await api(`github?workspace_id=${workspaceId}`);
      return res.json();
    },
  });
}

/** Projects page: connection state and "New project from GitHub". */
export function GithubConnectBar({ workspaceId, isAdmin }: { workspaceId: string; isAdmin: boolean }) {
  const status = useGithubStatus(workspaceId);
  const cache = useQueryClient();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<'connect' | 'pick' | null>(null);
  const connected = status.data?.connected;

  return (
    <div className={styles.bar}>
      <GithubMark />
      {connected ? (
        <>
          <span className={styles.barText}>GitHub <strong>@{status.data?.login}</strong> · weekly project check on Thursdays</span>
          <button type="button" className={styles.primary} onClick={() => setDialog('pick')}>New project from repository</button>
          {isAdmin && (
            <button type="button" className={styles.link} onClick={() => {
              if (!window.confirm('Disconnect GitHub? Weekly checks stop until you connect again.')) return;
              post({ action: 'disconnect', workspace_id: workspaceId })
                .then(() => cache.invalidateQueries({ queryKey: ['github-status', workspaceId] }))
                .catch((e: Error) => toast({ variant: 'error', description: e.message }));
            }}>Disconnect</button>
          )}
        </>
      ) : (
        <>
          <span className={styles.barText}>Turn GitHub repositories into projects; every Thursday the project agent checks commits against tasks.</span>
          {isAdmin
            ? <button type="button" className={styles.primary} onClick={() => setDialog('connect')}>Connect GitHub</button>
            : <span className={styles.muted}>An admin can connect GitHub.</span>}
        </>
      )}
      {dialog === 'connect' && <ConnectDialog workspaceId={workspaceId} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void cache.invalidateQueries({ queryKey: ['github-status', workspaceId] }); }} />}
      {dialog === 'pick' && <RepoPicker workspaceId={workspaceId} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ConnectDialog({ workspaceId, onClose, onDone }: { workspaceId: string; onClose: () => void; onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} title="Connect GitHub" size="md">
      <form className={styles.form} onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        post<{ login: string }>({ action: 'connect', workspace_id: workspaceId, token }).then(onDone).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
      }}>
        <ol className={styles.steps}>
          <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub → Fine-grained token</a>.</li>
          <li>Choose the repositories the project agent may read.</li>
          <li>Under <em>Repository permissions</em> set <strong>Contents</strong>, <strong>Issues</strong> and <strong>Metadata</strong> to <strong>Read-only</strong>. Nothing else.</li>
          <li>Generate the token and paste it here.</li>
        </ol>
        <input className={styles.input} type="password" autoComplete="off" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} aria-label="GitHub token" />
        <p className={styles.muted}>The token is stored encrypted on the server and never shown again. The agent can only read; it cannot change code.</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onClose}>Cancel</button>
          <button className={styles.primary} disabled={busy || token.trim().length < 20}>{busy ? 'Checking…' : 'Connect'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function RepoPicker({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const repos = useQuery({ queryKey: ['github-repos', workspaceId], queryFn: () => post<{ repos: Repo[] }>({ action: 'repos', workspace_id: workspaceId }) });
  const list = useMemo(() => (repos.data?.repos ?? []).filter((r) => !search.trim() || r.full_name.toLowerCase().includes(search.trim().toLowerCase())), [repos.data, search]);
  const create = (repo: Repo) => {
    setBusy(repo.full_name);
    post<{ project_id: string; imported: number; suggested: number }>({ action: 'create_project', workspace_id: workspaceId, repo: repo.full_name })
      .then((r) => {
        toast({ variant: 'success', description: `Project created: ${r.imported} issues imported as tasks${r.suggested ? `, ${r.suggested} suggested tasks waiting in Tasks → Approvals` : ''}.` });
        onClose();
        navigate(`/projects/${r.project_id}`);
      })
      .catch((e: Error) => toast({ variant: 'error', description: e.message }))
      .finally(() => setBusy(null));
  };
  return (
    <Dialog open onClose={onClose} title="New project from a repository" size="md">
      <div className={styles.form}>
        <input className={styles.input} autoFocus placeholder="Search repositories" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search repositories" />
        <div className={styles.repoList}>
          {repos.isPending && <p className={styles.muted}>Loading your repositories…</p>}
          {repos.error && <p className={styles.error}>{(repos.error as Error).message}</p>}
          {list.map((r) => (
            <button key={r.full_name} type="button" className={styles.repo} disabled={!!busy} onClick={() => create(r)}>
              <span className={styles.repoText}>
                <strong>{r.full_name}{r.private && <em> private</em>}</strong>
                <span>{r.description ?? 'No description'}</span>
              </span>
              <span className={styles.repoMeta}>{busy === r.full_name ? 'Creating…' : `${r.open_issues_count} open`}</span>
            </button>
          ))}
          {repos.data && !list.length && <p className={styles.muted}>No repositories match. The token only sees the repositories you gave it.</p>}
        </div>
        <p className={styles.muted}>Open issues become tasks. The agent also proposes starting tasks from the README and recent commits; you approve them in Tasks → Approvals.</p>
      </div>
    </Dialog>
  );
}

interface Link { project_id: string; repo_full_name: string; html_url: string | null; review_weekday: number; review_time: string; last_reviewed_at: string | null; last_review: { commits?: number; notes?: number; proposals?: number } | null }

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/** Project page: the linked repository, the last weekly review and "Check now". */
export function GithubProjectBar({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const link = useQuery({
    queryKey: ['github-link', projectId],
    queryFn: async (): Promise<Link | null> => {
      const { data } = await platform.from('project_github_links').select('*').eq('project_id', projectId).limit(1);
      return ((data as Link[] | null) ?? [])[0] ?? null;
    },
  });
  if (!link.data) return null;
  const l = link.data;
  const last = l.last_review;
  return (
    <div className={styles.projectBar}>
      <GithubMark />
      <a href={l.html_url ?? `https://github.com/${l.repo_full_name}`} target="_blank" rel="noopener noreferrer" className={styles.repoLink}>{l.repo_full_name}</a>
      <span className={styles.dot} aria-hidden="true">·</span>
      <span className={styles.barText}>Project agent checks commits {DAYS[l.review_weekday]} at {l.review_time.slice(0, 5)}</span>
      {l.last_reviewed_at && (
        <span className={styles.lastRun} title={new Date(l.last_reviewed_at).toLocaleString()}>
          Last: {last?.commits ?? 0} commits → {last?.notes ?? 0} task notes, {last?.proposals ?? 0} status changes to approve
        </span>
      )}
      <button type="button" className={styles.secondary} disabled={busy} onClick={() => {
        setBusy(true);
        post<{ commits: number; notes: number; proposals: number }>({ action: 'review', project_id: projectId })
          .then((r) => { toast({ variant: 'success', description: `Checked ${r.commits} commits: ${r.notes} tasks updated, ${r.proposals} status changes waiting for approval.` }); void link.refetch(); })
          .catch((e: Error) => toast({ variant: 'error', description: e.message }))
          .finally(() => setBusy(false));
      }}>{busy ? 'Checking…' : 'Check now'}</button>
    </div>
  );
}
