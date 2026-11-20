// Extras when a repository becomes a project: its own Drive folder, and the
// person's existing loose tasks that are clearly about the repository moved
// into it. Both run as that person, so Drive and task permissions apply.
import { asAuthenticated, databasePool, type AuthUser } from './database.js';
import { askJson } from './github.js';

/** My files → Projects → <repo name>, created (or reused) as the person. */
export async function createProjectFolder(user: AuthUser, workspaceId: string, projectId: string, repo: string): Promise<string> {
  const name = repo.split('/')[1] ?? repo;
  const folderId = await asAuthenticated(user, async (c) => {
    const findRoot = await c.query<{ id: string }>(
      `SELECT id FROM public.drive_items
        WHERE workspace_id = $1 AND parent_id IS NULL AND kind = 'folder' AND name = 'Projects'
          AND owner_id = auth.uid() AND trashed_at IS NULL
        ORDER BY created_at LIMIT 1`, [workspaceId]);
    const root = findRoot.rows[0]?.id
      ?? (await c.query<{ id: string }>(`SELECT (public.drive_create_folder($1, NULL, 'Projects')).id`, [workspaceId])).rows[0].id;
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM public.drive_items WHERE parent_id = $1 AND kind = 'folder' AND name = $2 AND trashed_at IS NULL LIMIT 1`, [root, name]);
    return existing.rows[0]?.id
      ?? (await c.query<{ id: string }>('SELECT (public.drive_create_folder($1, $2, $3)).id', [workspaceId, root, name])).rows[0].id;
  });
  await databasePool().query('UPDATE public.project_github_links SET drive_folder_id = $2 WHERE project_id = $1', [projectId, folderId]);
  return folderId;
}

/** Moves the person's open tasks without a project that are clearly about this repository into it. */
export async function linkExistingTasks(user: AuthUser, workspaceId: string, projectId: string, repo: string, description: string | null): Promise<number> {
  const candidates = await asAuthenticated(user, async (c) => (await c.query<{ id: string; title: string; description: string | null }>(
    `SELECT t.id, t.title, left(coalesce(t.description, ''), 300) AS description
       FROM public.tasks t
      WHERE t.workspace_id = $1 AND t.project_id IS NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL
        AND coalesce(t.status, 'todo') <> 'done'
      ORDER BY t.created_at DESC LIMIT 200`, [workspaceId])).rows);
  if (!candidates.length) return 0;

  const answer = await askJson<{ task_ids: string[] }>(
    'You sort tasks into software projects. Be conservative: pick a task only when its title or description clearly refers to this repository\'s product, site or codebase. Reply with JSON only.',
    `Repository: ${repo}\nDescription: ${description ?? '—'}\n\nTasks without a project:\n${candidates.map((t) => `- id=${t.id} ${t.title}${t.description ? ` — ${t.description.replace(/\s+/g, ' ')}` : ''}`).join('\n')}\n\n` +
    'Which tasks belong to this repository? Reply as {"task_ids":["…"]} (an empty list when none clearly do).',
  );
  const known = new Set(candidates.map((t) => t.id));
  const ids = (answer?.task_ids ?? []).filter((id) => known.has(id));
  if (!ids.length) return 0;

  const moved = await asAuthenticated(user, async (c) => (await c.query<{ id: string }>(
    `UPDATE public.tasks
        SET project_id = $1,
            column_id = (SELECT id FROM public.project_columns WHERE project_id = $1 AND lower(name) = 'to do' ORDER BY position LIMIT 1),
            updated_at = now()
      WHERE id = ANY($2::uuid[]) AND workspace_id = $3 AND project_id IS NULL
      RETURNING id`, [projectId, ids, workspaceId])).rows);
  if (moved.length) {
    await databasePool().query(
      `INSERT INTO public.task_activity (task_id, user_id, action, description)
       SELECT unnest($1::uuid[]), $2, 'edited', 'Moved into project ' || $3 || ' (matched to its GitHub repository)'`,
      [moved.map((m) => m.id), user.id, repo]);
  }
  return moved.length;
}
