// The GitHub project agent. A workspace connects a read-only GitHub token
// (sealed with AES-GCM, never sent back to browsers); a repository becomes a
// project with its open issues as tasks plus AI-suggested tasks for approval;
// and every week the agent compares the project's tasks with the commits,
// notes progress on matched tasks, notifies their assignees and proposes
// status changes for a project manager to approve.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { databasePool, rpc } from './database.js';
import { HttpError } from './http.js';
import { log } from './log.js';
import { platformDefaultModel, providerFor } from './ai/registry.js';
import { accountToken } from './github-accounts.js';

export const API = 'https://api.github.com';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface Sealed { iv: string; tag: string; data: string }

export function key(): Buffer {
  const secret = process.env.APP_JWT_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error('APP_JWT_SECRET is required to protect GitHub tokens.');
  return createHash('sha256').update(`dromanian-github-tokens:${secret}`).digest();
}

export function sealToken(token: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function openToken(sealed: Sealed): string {
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
}

export async function gh<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'darkspace-project-agent',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) throw new HttpError(400, 'github_token_invalid', 'GitHub rejected the token. Create a new one and connect again.');
  if (res.status === 403 || res.status === 404) throw new HttpError(400, 'github_no_access', 'The token cannot read that repository. Give it read access to the repository and try again.');
  if (!res.ok) throw new HttpError(502, 'github_error', `GitHub answered ${res.status}. Try again in a minute.`);
  return (await res.json()) as T;
}

// ── Connection ──────────────────────────────────────────────────────────────

export async function connectionFor(workspaceId: string): Promise<{ login: string; token: string; connected_at: string } | null> {
  const r = await databasePool().query('SELECT login, token_sealed, connected_at FROM public.workspace_github_connections WHERE workspace_id = $1', [workspaceId]);
  if (!r.rowCount) return null;
  return { login: r.rows[0].login, token: openToken(r.rows[0].token_sealed), connected_at: r.rows[0].connected_at };
}

export async function connect(workspaceId: string, userId: string, token: string): Promise<{ login: string }> {
  const me = await gh<{ login: string }>(token.trim(), '/user');
  await databasePool().query(
    `INSERT INTO public.workspace_github_connections (workspace_id, login, token_sealed, connected_by)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (workspace_id) DO UPDATE SET login = excluded.login, token_sealed = excluded.token_sealed,
       connected_by = excluded.connected_by, connected_at = now()`,
    [workspaceId, me.login, JSON.stringify(sealToken(token.trim())), userId],
  );
  return { login: me.login };
}

export async function disconnect(workspaceId: string): Promise<void> {
  await databasePool().query('DELETE FROM public.workspace_github_connections WHERE workspace_id = $1', [workspaceId]);
}

async function tokenFor(workspaceId: string): Promise<string> {
  const c = await connectionFor(workspaceId);
  if (!c) throw new HttpError(400, 'github_not_connected', 'Connect GitHub first (Projects → Connect GitHub).');
  return c.token;
}

export interface RepoSummary { full_name: string; description: string | null; private: boolean; default_branch: string; html_url: string; pushed_at: string; open_issues_count: number }

export async function listRepos(workspaceId: string): Promise<RepoSummary[]> {
  const token = await tokenFor(workspaceId);
  const repos = await gh<RepoSummary[]>(token, '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
  return repos.map((r) => ({
    full_name: r.full_name, description: r.description, private: r.private, default_branch: r.default_branch,
    html_url: r.html_url, pushed_at: r.pushed_at, open_issues_count: r.open_issues_count,
  }));
}

// ── AI ──────────────────────────────────────────────────────────────────────

/** One model turn that must answer with JSON; returns null when it can't. */
export async function askJson<T>(system: string, prompt: string): Promise<T | null> {
  const model = platformDefaultModel();
  const provider = providerFor(model);
  if (!provider?.configured()) return null;
  const session = provider.startSession({
    model, effort: 'medium', system, history: [], userMessage: prompt, tools: [],
    webSearch: null, webFetch: null, maxTokens: 6000,
  });
  const turn = await session.next({ signal: AbortSignal.timeout(120_000), onText: () => {} });
  const text = turn.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)) as T; } catch { return null; }
}

// ── Projects from repositories ──────────────────────────────────────────────

interface Issue { number: number; title: string; body: string | null; html_url: string; pull_request?: unknown }
interface Commit { sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } | null }; author: { login: string } | null }

export async function createProjectFromRepo(workspaceId: string, userId: string, repoName: string, accountId?: string) {
  if (!REPO.test(repoName)) throw new HttpError(400, 'bad_repo', 'Choose a repository as owner/name.');
  const token = accountId ? await accountToken(accountId) : await tokenFor(workspaceId);
  const repo = await gh<RepoSummary>(token, `/repos/${repoName}`);
  const projectId = await rpc<string>('github_create_project', {
    p_actor: userId, p_workspace_id: workspaceId, p_repo: repo.full_name, p_description: repo.description,
    p_branch: repo.default_branch, p_url: repo.html_url,
  });
  if (accountId) await rpc('github_link_account', { p_project_id: projectId, p_account_id: accountId });
  const issues = (await gh<Issue[]>(token, `/repos/${repo.full_name}/issues?state=open&per_page=100`)).filter((i) => !i.pull_request);
  const imported = await rpc<number>('github_import_issues', {
    p_actor: userId, p_project_id: projectId,
    p_issues: issues.map((i) => ({ number: i.number, title: i.title, body: (i.body ?? '').slice(0, 4000), url: i.html_url })),
  });

  let suggested = 0;
  try {
    const readme = await fetch(`${API}/repos/${repo.full_name}/readme`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github.raw', 'user-agent': 'darkspace-project-agent' },
      signal: AbortSignal.timeout(20_000),
    }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    const commits = await gh<Commit[]>(token, `/repos/${repo.full_name}/commits?per_page=30`).catch(() => [] as Commit[]);
    const ideas = await askJson<{ tasks: Array<{ title: string; description?: string; priority?: string }> }>(
      'You are the project manager for a software repository. You propose a short starting task list. Reply with JSON only.',
      `Repository: ${repo.full_name}\nDescription: ${repo.description ?? '—'}\n\nOpen issues (already tasks):\n${issues.map((i) => `- #${i.number} ${i.title}`).join('\n') || '(none)'}\n\nRecent commits:\n${commits.map((c) => `- ${c.commit.message.split('\n')[0]}`).join('\n') || '(none)'}\n\nREADME (truncated):\n${readme.slice(0, 6000)}\n\n` +
      'Propose up to 8 concrete next tasks that are NOT already covered by the open issues: things the README promises but the code does not show yet, follow-ups to recent work, missing tests or docs. ' +
      'Each title is an action under 90 characters. Reply as {"tasks":[{"title":"…","description":"why and what done looks like","priority":"low|medium|high"}]}.',
    );
    if (ideas?.tasks?.length) {
      suggested = await rpc<number>('github_suggest_tasks', { p_actor: userId, p_project_id: projectId, p_tasks: ideas.tasks.slice(0, 8) });
    }
  } catch (err) {
    log.warn('github task suggestions failed', { repo: repo.full_name, error: err instanceof Error ? err : String(err) });
  }
  return { project_id: projectId, imported, suggested, description: repo.description };
}

// ── Weekly review ───────────────────────────────────────────────────────────

interface Link { project_id: string; workspace_id: string; repo_full_name: string; default_branch: string; last_reviewed_at: string | null; github_account_id: string | null }

export async function reviewProject(projectId: string): Promise<{ commits: number; notes: number; proposals: number }> {
  const r = await databasePool().query<Link>('SELECT project_id, workspace_id, repo_full_name, default_branch, last_reviewed_at, github_account_id FROM public.project_github_links WHERE project_id = $1', [projectId]);
  const link = r.rows[0];
  if (!link) throw new HttpError(404, 'not_found', 'This project is not linked to GitHub.');
  // The account that created the project; older projects use the workspace token.
  const token = link.github_account_id ? await accountToken(link.github_account_id) : await tokenFor(link.workspace_id);
  const since = link.last_reviewed_at ? new Date(link.last_reviewed_at) : new Date(Date.now() - 7 * 864e5);
  const commits = await gh<Commit[]>(token, `/repos/${link.repo_full_name}/commits?sha=${encodeURIComponent(link.default_branch)}&since=${since.toISOString()}&per_page=100`);

  const tasks = (await databasePool().query<{ id: string; title: string; description: string | null; status: string | null; assignees: string[] | null }>(
    `SELECT t.id, t.title, left(coalesce(t.description, ''), 400) AS description, t.status,
            array_agg(coalesce(p.display_name, p.username)) FILTER (WHERE a.user_id IS NOT NULL) AS assignees
       FROM public.tasks t
       LEFT JOIN public.task_assignees a ON a.task_id = t.id
       LEFT JOIN public.profiles p ON p.id = a.user_id
      WHERE t.project_id = $1 AND t.archived_at IS NULL AND t.deleted_at IS NULL AND coalesce(t.status, 'todo') <> 'done'
      GROUP BY t.id ORDER BY t.created_at LIMIT 150`, [projectId])).rows;

  let items: Array<{ task_id: string; note: string; commits: Array<{ sha: string; url: string; message: string }>; suggested_status: string | null }> = [];
  if (commits.length && tasks.length) {
    const bySha = new Map(commits.map((c) => [c.sha.slice(0, 7), c]));
    const answer = await askJson<{ updates: Array<{ task_id: string; commits: string[]; note: string; suggested_status: 'in_progress' | 'done' | null }> }>(
      'You are the project manager agent of a software team. You compare a project\'s open tasks with the week\'s commits. Be conservative: only link a commit to a task when the commit clearly works on it. Reply with JSON only.',
      `Repository ${link.repo_full_name}, branch ${link.default_branch}, commits since ${since.toISOString().slice(0, 10)}:\n` +
      commits.map((c) => `- ${c.sha.slice(0, 7)} by ${c.author?.login ?? c.commit.author?.name ?? 'unknown'}: ${c.commit.message.split('\n').slice(0, 3).join(' / ')}`).join('\n') +
      `\n\nOpen tasks:\n${tasks.map((t) => `- id=${t.id} [${t.status ?? 'todo'}] ${t.title}${t.assignees?.length ? ` (assigned: ${t.assignees.join(', ')})` : ''}${t.description ? ` — ${t.description.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`).join('\n')}\n\n` +
      'For each task that commits clearly worked on, write a 1–2 sentence progress note naming what changed, list the short shas, and suggest a status: "done" only when the commits clearly complete it, "in_progress" when they start or advance it, null if unsure. Skip tasks with no related commits. ' +
      'Reply as {"updates":[{"task_id":"…","commits":["abc1234"],"note":"…","suggested_status":"in_progress|done|null"}]}.',
    );
    const known = new Set(tasks.map((t) => t.id));
    items = (answer?.updates ?? [])
      .filter((u) => known.has(u.task_id) && u.note)
      .map((u) => ({
        task_id: u.task_id,
        note: u.note.slice(0, 1500),
        suggested_status: u.suggested_status === 'done' || u.suggested_status === 'in_progress' ? u.suggested_status : null,
        commits: (u.commits ?? []).map((s) => bySha.get(String(s).slice(0, 7))).filter((c): c is Commit => !!c)
          .map((c) => ({ sha: c.sha.slice(0, 7), url: c.html_url, message: c.commit.message.split('\n')[0].slice(0, 200) })),
      }));
  }
  const applied = await rpc<{ notes: number; proposals: number }>('github_apply_review', {
    p_project_id: projectId,
    p_items: items,
    p_summary: { commits: commits.length, open_tasks: tasks.length, since: since.toISOString(), at: new Date().toISOString() },
  });
  return { commits: commits.length, ...applied };
}

/** Worker maintenance: runs each project's weekly review once its time has come. */
export async function runGithubReviews(): Promise<number> {
  const due = await rpc<{ project_id: string }[]>('github_claim_due_reviews');
  let done = 0;
  for (const { project_id } of due) {
    try {
      const result = await reviewProject(project_id);
      log.info('github weekly review', { project_id, ...result });
      done++;
    } catch (err) {
      log.warn('github weekly review failed', { project_id, error: err instanceof Error ? err : String(err) });
    }
  }
  return done;
}
