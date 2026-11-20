// The GitHub project agent in the app: connected GitHub accounts (VS Code
// style sign-in), turning a repository into a project, and a linked project's
// weekly review.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/features/platform/client';
import { platform } from '@/lib/platform';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import styles from './GithubProjects.module.css';

export interface GithubAccount { id: string; github_id: number; login: string; name: string | null; avatar_url: string | null; created_at: string }
interface Status {
  connected: boolean;
  login: string | null;
  connected_at: string | null;
  app: { slug: string; html_url: string | null } | null;
  accounts: GithubAccount[];
}
interface Repo { full_name: string; description: string | null; private: boolean; default_branch: string; html_url: string; pushed_at: string; open_issues_count: number }

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const res = await api('github', body);
  return res.json() as Promise<T>;
}

export const GithubMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className={className ?? styles.mark}>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

export function useGithubStatus(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['github-status', workspaceId],
    enabled: !!workspaceId,
    staleTime: 30_000,
    queryFn: async (): Promise<Status> => (await api(`github?workspace_id=${workspaceId}`)).json(),
  });
}

/** Opens GitHub's sign-in; GitHub sends the person back to Connected accounts. */
export async function connectGithubAccount(another = false) {
  const { url } = await post<{ url: string }>({ action: 'authorize', origin: window.location.origin, another });
  window.location.assign(url);
}

/** One-time server setup: GitHub registers a read-only Darkspace app from a manifest. */
export async function setUpGithubApp(workspaceId: string) {
  const { action, manifest } = await post<{ action: string; manifest: unknown }>({ action: 'app_manifest', workspace_id: workspaceId, origin: window.location.origin });
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = JSON.stringify(manifest);
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

/** Settings → Connected accounts: like VS Code's Accounts menu. */
export function ConnectedAccounts({ workspaceId, isAdmin }: { workspaceId: string; isAdmin: boolean }) {
  const status = useGithubStatus(workspaceId);
  const cache = useQueryClient();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);

  // Coming back from GitHub.
  useEffect(() => {
    const done = params.get('github');
    const failed = params.get('github_error');
    if (!done && !failed) return;
    if (failed) toast({ variant: 'error', description: failed });
    else if (done === 'connected') toast({ variant: 'success', description: `GitHub account @${params.get('login') ?? ''} connected.` });
    else toast({ variant: 'success', description: 'GitHub access updated.' });
    void cache.invalidateQueries({ queryKey: ['github-status', workspaceId] });
    const next = new URLSearchParams(params);
    ['github', 'github_error', 'login'].forEach((k) => next.delete(k));
    setParams(next, { replace: true });
  }, [params, setParams, toast, cache, workspaceId]);

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().catch((e: Error) => { toast({ variant: 'error', description: e.message }); setBusy(false); });
  };
  const accounts = status.data?.accounts ?? [];
  const app = status.data?.app;

  return (
    <section className={styles.accounts}>
      <header className={styles.accountsHead}>
        <div>
          <h3>Connected accounts</h3>
          <p className={styles.muted}>Accounts you sign in to from Darkspace. Only you can use yours; disconnecting stops access immediately.</p>
        </div>
      </header>

      <div className={styles.provider}>
        <div className={styles.providerHead}>
          <GithubMark className={styles.providerMark} />
          <div className={styles.providerText}>
            <strong>GitHub</strong>
            <span>Read-only: repositories, issues and commits for the project agent.</span>
          </div>
          {app ? (
            <button type="button" className={styles.primary} disabled={busy} onClick={() => run(() => connectGithubAccount(accounts.length > 0))}>
              {accounts.length ? 'Add another account' : 'Connect GitHub account'}
            </button>
          ) : isAdmin ? (
            <button type="button" className={styles.primary} disabled={busy} onClick={() => run(() => setUpGithubApp(workspaceId))}>Set up GitHub sign-in</button>
          ) : null}
        </div>

        {!app && (
          <p className={styles.setupNote}>
            {isAdmin
              ? 'One-time setup: GitHub opens a page to create the read-only “Darkspace” app on your GitHub account. Confirm it, choose the repositories, and you are signed in.'
              : 'An admin needs to set up GitHub sign-in once before anyone can connect an account.'}
          </p>
        )}

        {accounts.length > 0 && (
          <ul className={styles.accountList}>
            {accounts.map((a) => (
              <li key={a.id} className={styles.account}>
                {a.avatar_url ? <img src={a.avatar_url} alt="" className={styles.avatar} /> : <span className={styles.avatar} />}
                <span className={styles.accountText}>
                  <strong>{a.name ?? a.login}</strong>
                  <span>@{a.login} · connected {new Date(a.created_at).toLocaleDateString()}</span>
                </span>
                {app && (
                  <a className={styles.link} href={`https://github.com/apps/${app.slug}/installations/new`} target="_blank" rel="noopener noreferrer">Choose repositories</a>
                )}
                <button type="button" className={styles.disconnect} onClick={() => {
                  if (!window.confirm(`Disconnect @${a.login}? Projects created through it stop their weekly check until it is connected again.`)) return;
                  post({ action: 'disconnect_account', account_id: a.id })
                    .then(() => cache.invalidateQueries({ queryKey: ['github-status', workspaceId] }))
                    .catch((e: Error) => toast({ variant: 'error', description: e.message }));
                }}>Disconnect</button>
              </li>
            ))}
          </ul>
        )}
        {accounts.length > 0 && <p className={styles.muted}>Add another account opens GitHub’s account picker, where you can choose or sign in to a different GitHub account. Each one then appears here with its own repositories.</p>}
      </div>
    </section>
  );
}

/** Projects page: connected accounts and "New project from repository". */
export function GithubConnectBar({ workspaceId, isAdmin }: { workspaceId: string; isAdmin: boolean }) {
  const status = useGithubStatus(workspaceId);
  const navigate = useNavigate();
  const { toast } = useToast();
  const [picking, setPicking] = useState(false);
  const accounts = status.data?.accounts ?? [];
  const legacy = !!status.data?.login;
  const app = status.data?.app;
  if (status.isPending) return null;

  return (
    <div className={styles.bar}>
      <GithubMark />
      {accounts.length || legacy ? (
        <>
          <span className={styles.chips}>
            {accounts.map((a) => (
              <span key={a.id} className={styles.chip} title={a.name ?? a.login}>
                {a.avatar_url && <img src={a.avatar_url} alt="" />}@{a.login}
              </span>
            ))}
            {!accounts.length && legacy && <span className={styles.chip}>@{status.data?.login} (token)</span>}
          </span>
          <span className={styles.barText}>Weekly project check on Thursdays</span>
          <button type="button" className={styles.link} onClick={() => navigate('/settings?tab=accounts')}>Manage accounts</button>
          <button type="button" className={styles.primary} onClick={() => setPicking(true)}>New project from repository</button>
        </>
      ) : (
        <>
          <span className={styles.barText}>Connect your GitHub account to turn repositories into projects; every Thursday the project agent checks commits against tasks.</span>
          {app ? (
            <button type="button" className={styles.primary} onClick={() => connectGithubAccount().catch((e: Error) => toast({ variant: 'error', description: e.message }))}>Connect GitHub account</button>
          ) : isAdmin ? (
            <button type="button" className={styles.primary} onClick={() => setUpGithubApp(workspaceId).catch((e: Error) => toast({ variant: 'error', description: e.message }))}>Set up GitHub sign-in</button>
          ) : (
            <span className={styles.muted}>An admin needs to set up GitHub sign-in.</span>
          )}
        </>
      )}
      {picking && <RepoPicker workspaceId={workspaceId} accounts={accounts} onClose={() => setPicking(false)} />}
    </div>
  );
}

function RepoPicker({ workspaceId, accounts, onClose }: { workspaceId: string; accounts: GithubAccount[]; onClose: () => void }) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [accountId, setAccountId] = useState<string | undefined>(accounts[0]?.id);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [driveFolder, setDriveFolder] = useState(true);
  const [linkTasks, setLinkTasks] = useState(true);
  const [progress, setProgress] = useState<Record<string, { state: 'waiting' | 'working' | 'done' | 'failed'; note?: string; projectId?: string }>>({});
  const running = Object.values(progress).some((p) => p.state === 'waiting' || p.state === 'working');
  const finished = Object.keys(progress).length > 0 && !running;
  const repos = useQuery({
    queryKey: ['github-repos', workspaceId, accountId ?? 'token'],
    queryFn: () => post<{ repos: Repo[] }>({ action: 'repos', workspace_id: workspaceId, ...(accountId ? { account_id: accountId } : {}) }),
  });
  const existing = useQuery({
    queryKey: ['github-linked', workspaceId],
    queryFn: async () => {
      const { data } = await platform.from('project_github_links').select('repo_full_name,project_id').eq('workspace_id', workspaceId);
      return new Map(((data ?? []) as { repo_full_name: string; project_id: string }[]).map((r) => [r.repo_full_name.toLowerCase(), r.project_id]));
    },
  });
  const list = useMemo(() => (repos.data?.repos ?? []).filter((r) => !search.trim() || r.full_name.toLowerCase().includes(search.trim().toLowerCase())), [repos.data, search]);
  const toggle = (name: string) => setPicked((p) => { const n = new Set(p); if (n.has(name)) n.delete(name); else n.add(name); return n; });

  const createAll = async () => {
    const names = [...picked];
    setProgress(Object.fromEntries(names.map((n) => [n, { state: 'waiting' as const }])));
    for (const name of names) {
      setProgress((p) => ({ ...p, [name]: { state: 'working' } }));
      try {
        const r = await post<{ project_id: string; imported: number; folder_id: string | null }>({
          action: 'create_project', workspace_id: workspaceId, repo: name, ...(accountId ? { account_id: accountId } : {}),
          drive_folder: driveFolder, link_tasks: linkTasks,
        });
        const parts = [`${r.imported} issues → tasks`];
        if (driveFolder) parts.push(r.folder_id ? 'Drive folder ready' : 'no Drive folder');
        // The AI steps finish on the server after this answer.
        parts.push(linkTasks ? 'AI task suggestions and matching follow in a few minutes' : 'AI task suggestions follow in a few minutes');
        setProgress((p) => ({ ...p, [name]: { state: 'done', note: parts.join(' · '), projectId: r.project_id } }));
      } catch (e) {
        setProgress((p) => ({ ...p, [name]: { state: 'failed', note: (e as Error).message } }));
      }
    }
    void cache.invalidateQueries({ queryKey: ['github-linked', workspaceId] });
  };

  const days = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 864e5));

  return (
    <Dialog open onClose={running ? () => {} : onClose} title="New projects from repositories" size="lg">
      <div className={styles.form}>
        {Object.keys(progress).length ? (
          <>
            <ul className={styles.progressList}>
              {Object.entries(progress).map(([name, p]) => (
                <li key={name} data-state={p.state}>
                  <span className={styles.progressDot} aria-hidden="true" />
                  <span className={styles.repoText}>
                    <strong>{name}</strong>
                    <span>{p.state === 'waiting' ? 'Waiting…' : p.state === 'working' ? 'Creating the project and importing issues…' : p.note}</span>
                  </span>
                  {p.projectId && <button type="button" className={styles.link} onClick={() => { onClose(); navigate(`/projects/${p.projectId}`); }}>Open</button>}
                </li>
              ))}
            </ul>
            {finished && <div className={styles.actions}><button type="button" className={styles.primary} onClick={onClose}>Done</button></div>}
          </>
        ) : (
          <>
            {accounts.length > 1 && (
              <div className={styles.accountTabs} role="tablist" aria-label="GitHub account">
                {accounts.map((a) => (
                  <button key={a.id} type="button" role="tab" aria-selected={a.id === accountId} className={a.id === accountId ? styles.accountTabOn : undefined} onClick={() => { setAccountId(a.id); setPicked(new Set()); }}>
                    {a.avatar_url && <img src={a.avatar_url} alt="" />}@{a.login}
                  </button>
                ))}
              </div>
            )}
            <input className={styles.input} autoFocus placeholder="Search repositories" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search repositories" />
            <div className={styles.repoList}>
              {repos.isPending && <p className={styles.muted}>Loading repositories…</p>}
              {repos.error && <p className={styles.error}>{(repos.error as Error).message}</p>}
              {list.map((r) => {
                const already = existing.data?.get(r.full_name.toLowerCase());
                return (
                  <label key={r.full_name} className={`${styles.repo} ${already ? styles.repoDone : ''}`}>
                    <input type="checkbox" disabled={!!already} checked={picked.has(r.full_name)} onChange={() => toggle(r.full_name)} />
                    <span className={styles.repoText}>
                      <strong>{r.full_name}{r.private && <em> private</em>}</strong>
                      <span>{r.description ?? 'No description'}</span>
                    </span>
                    <span className={styles.repoMeta}>
                      {already ? 'Already a project' : `pushed ${days(r.pushed_at)}d ago · ${r.open_issues_count} open`}
                    </span>
                  </label>
                );
              })}
              {repos.data && !list.length && <p className={styles.muted}>No repositories here. Use “Choose repositories” in Settings → Connected accounts to give Darkspace access to more.</p>}
            </div>
            <div className={styles.options}>
              <label><input type="checkbox" checked={driveFolder} onChange={(e) => setDriveFolder(e.target.checked)} /> Create a Drive folder for each (My files → Projects)</label>
              <label><input type="checkbox" checked={linkTasks} onChange={(e) => setLinkTasks(e.target.checked)} /> Move my existing tasks that clearly belong to the repository into its project</label>
            </div>
            <p className={styles.muted}>Open issues become tasks; the agent also proposes starting tasks for Tasks → Approvals. Every Thursday it checks each project’s commits against its tasks.</p>
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} onClick={onClose}>Cancel</button>
              <button type="button" className={styles.primary} disabled={!picked.size} onClick={() => void createAll()}>
                {picked.size ? `Create ${picked.size} project${picked.size === 1 ? '' : 's'}` : 'Select repositories'}
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

interface Link { project_id: string; drive_folder_id: string | null; repo_full_name: string; html_url: string | null; review_weekday: number; review_time: string; last_reviewed_at: string | null; last_review: { commits?: number; notes?: number; proposals?: number } | null }

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/** Project page: the linked repository, the last weekly review and "Check now". */
export function GithubProjectBar({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const link = useQuery({
    queryKey: ['github-link', projectId],
    queryFn: async (): Promise<Link | null> => {
      const { data } = await platform.from('project_github_links').select('project_id,drive_folder_id,repo_full_name,html_url,review_weekday,review_time,last_reviewed_at,last_review').eq('project_id', projectId).limit(1);
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
      {l.drive_folder_id && <><span className={styles.dot} aria-hidden="true">·</span><a className={styles.repoLink} href={`/drive/folder/${l.drive_folder_id}`}>Drive folder</a></>}
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
