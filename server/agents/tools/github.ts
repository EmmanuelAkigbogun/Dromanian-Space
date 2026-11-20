// GitHub, read-only, for agents: the requester's connected GitHub accounts,
// their repositories, and one repository's recent commits and open issues
// next to its linked Darkspace project and tasks. Tokens never reach the model.
import { z } from 'zod';
import { databasePool } from '../../database.js';
import { accountToken, listAccountRepos } from '../../github-accounts.js';
import { gh } from '../../github.js';
import { defineTool, quoteData } from './types.js';

interface Account { id: string; login: string }

async function accountsOf(userId: string): Promise<Account[]> {
  const r = await databasePool().query('SELECT id, login FROM public.user_github_accounts WHERE user_id = $1 ORDER BY created_at', [userId]);
  return r.rows as Account[];
}

const NOT_CONNECTED = 'The requester has no GitHub account connected. Tell them to connect one in Settings → Connected accounts (or the avatar menu → Connected accounts); then you can list and read their repositories.';

export const listGithubRepos = defineTool({
  name: 'list_github_repos',
  description: 'List the GitHub repositories the requester can read through their connected GitHub accounts (Settings → Connected accounts), with which ones are already Darkspace projects. Use this whenever the user asks about their repositories, connected accounts or GitHub; never ask them to paste a repository list.',
  schema: z.object({ query: z.string().max(100).optional() }),
  label: () => 'Listing GitHub repositories',
  async run(ctx, input) {
    const accounts = await accountsOf(ctx.actorId);
    if (!accounts.length) return { content: NOT_CONNECTED, summary: { accounts: 0 } };
    const linked = await databasePool().query<{ repo: string; project_id: string; name: string }>(
      `SELECT lower(l.repo_full_name) AS repo, l.project_id, p.name FROM public.project_github_links l
         JOIN public.projects p ON p.id = l.project_id AND p.deleted_at IS NULL
        WHERE l.workspace_id = $1`, [ctx.workspaceId]);
    const projects = new Map(linked.rows.map((r) => [r.repo, r]));
    const lines: string[] = [];
    let total = 0;
    for (const account of accounts) {
      let repos;
      try { repos = await listAccountRepos(account.id); } catch (err) {
        lines.push(`@${account.login}: could not read repositories (${err instanceof Error ? err.message : 'error'})`);
        continue;
      }
      const q = input.query?.toLowerCase();
      const shown = q ? repos.filter((r) => r.full_name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q)) : repos;
      total += shown.length;
      lines.push(`@${account.login} — ${shown.length} repositories`);
      for (const r of shown.slice(0, 100)) {
        const project = projects.get(r.full_name.toLowerCase());
        lines.push(`- ${r.full_name}${r.private ? ' (private)' : ''} · ${r.open_issues_count} open issues · last push ${r.pushed_at?.slice(0, 10) ?? '—'}${r.description ? ` · ${r.description}` : ''}${project ? ` · Darkspace project “${project.name}” (/projects/${project.project_id})` : ' · not a project yet'}`);
      }
    }
    return { content: quoteData('github_repositories', { accounts: accounts.map((a) => a.login).join(', ') }, lines.join('\n')), summary: { accounts: accounts.length, repositories: total } };
  },
});

export const readGithubRepo = defineTool({
  name: 'read_github_repo',
  description: 'Read one GitHub repository (owner/name) through the requester\'s connected accounts: recent commits, open issues and, when it is a Darkspace project, that project\'s open tasks with assignees and statuses. Use it to pair commits or issues with tasks.',
  schema: z.object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    commits: z.number().int().min(1).max(100).optional(),
  }),
  label: (input) => `Reading ${input.repo} on GitHub`,
  async run(ctx, input) {
    const accounts = await accountsOf(ctx.actorId);
    if (!accounts.length) return { content: NOT_CONNECTED, summary: { accounts: 0 } };
    let token: string | null = null;
    for (const a of accounts) {
      try {
        const t = await accountToken(a.id);
        await gh(t, `/repos/${input.repo}`);
        token = t;
        break;
      } catch { /* try the next account */ }
    }
    if (!token) return { content: `None of the requester's connected GitHub accounts can read ${input.repo}. They can grant access with “Choose repositories” in Settings → Connected accounts.`, summary: { repo: input.repo, readable: false } };

    const [commits, issues] = await Promise.all([
      gh<Array<{ sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } | null }; author: { login: string } | null }>>(token, `/repos/${input.repo}/commits?per_page=${input.commits ?? 30}`),
      gh<Array<{ number: number; title: string; html_url: string; assignee: { login: string } | null; pull_request?: unknown }>>(token, `/repos/${input.repo}/issues?state=open&per_page=50`),
    ]);
    const project = await databasePool().query<{ project_id: string; name: string }>(
      `SELECT l.project_id, p.name FROM public.project_github_links l JOIN public.projects p ON p.id = l.project_id AND p.deleted_at IS NULL
        WHERE l.workspace_id = $1 AND lower(l.repo_full_name) = lower($2)`, [ctx.workspaceId, input.repo]);
    let tasks: string[] = [];
    if (project.rowCount) {
      const rows = await databasePool().query<{ id: string; title: string; status: string | null; assignees: string | null }>(
        `SELECT t.id, t.title, t.status, string_agg(coalesce(pr.display_name, pr.username), ', ') AS assignees
           FROM public.tasks t
           LEFT JOIN public.task_assignees a ON a.task_id = t.id
           LEFT JOIN public.profiles pr ON pr.id = a.user_id
          WHERE t.project_id = $1 AND t.deleted_at IS NULL AND t.archived_at IS NULL AND coalesce(t.status, 'todo') <> 'done'
          GROUP BY t.id ORDER BY t.created_at LIMIT 100`, [project.rows[0].project_id]);
      tasks = rows.rows.map((t) => `- [${t.status ?? 'todo'}] ${t.title}${t.assignees ? ` (assigned: ${t.assignees})` : ''} · /tasks/${t.id}`);
    }
    const body = [
      `Recent commits (${commits.length}):`,
      ...commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.commit.author?.date?.slice(0, 10) ?? ''} by ${c.author?.login ?? c.commit.author?.name ?? 'unknown'}: ${c.commit.message.split('\n')[0]} (${c.html_url})`),
      '',
      `Open issues (${issues.filter((i) => !i.pull_request).length}):`,
      ...issues.filter((i) => !i.pull_request).map((i) => `- #${i.number} ${i.title}${i.assignee ? ` (assigned: @${i.assignee.login})` : ''} (${i.html_url})`),
      '',
      project.rowCount ? `Darkspace project “${project.rows[0].name}” (/projects/${project.rows[0].project_id}) open tasks:` : 'Not a Darkspace project yet (Projects → New project from repository).',
      ...tasks,
    ].join('\n');
    return { content: quoteData('github_repository', { repo: input.repo }, body), summary: { repo: input.repo, commits: commits.length, issues: issues.length, tasks: tasks.length } };
  },
});
