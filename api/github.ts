// /api/github — the GitHub project agent.
//   GET  ?workspace_id=…                         connection status (members)
//   POST {action:'connect', workspace_id, token} store a read-only token (admins)
//   POST {action:'disconnect', workspace_id}     forget it (admins)
//   POST {action:'repos', workspace_id}          repositories the token can read
//   POST {action:'create_project', workspace_id, repo}
//   POST {action:'review', project_id}           run the weekly review now
//   POST {action:'app_manifest'|'authorize'|'disconnect_account'} connected accounts (GitHub App sign-in)
import { z } from 'zod';
import { asAuthenticated, authenticate, databasePool } from '../server/database.js';
import { errorResponse, HttpError, json, readJson } from '../server/http.js';
import { connect, connectionFor, createProjectFromRepo, disconnect, listRepos, reviewProject } from '../server/github.js';
import { accountsOf, appConfig, appManifest, authorizeUrl, listAccountRepos, ownAccount, signState } from '../server/github-accounts.js';

const uuid = z.string().uuid();
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect'), workspace_id: uuid, token: z.string().min(20).max(400) }),
  z.object({ action: z.literal('disconnect'), workspace_id: uuid }),
  z.object({ action: z.literal('repos'), workspace_id: uuid, account_id: uuid.optional() }),
  z.object({ action: z.literal('create_project'), workspace_id: uuid, repo: z.string().min(3).max(200), account_id: uuid.optional() }),
  z.object({ action: z.literal('app_manifest'), workspace_id: uuid, origin: z.string().url() }),
  z.object({ action: z.literal('authorize'), origin: z.string().url() }),
  z.object({ action: z.literal('disconnect_account'), account_id: uuid }),
  z.object({ action: z.literal('review'), project_id: uuid }),
]);

type User = Awaited<ReturnType<typeof authenticate>>;

/** The browser's origin, accepted only when it is the host this request came to. */
function checkedOrigin(request: Request, claimed: string): string {
  const origin = new URL(claimed).origin;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
  const isLocal = (h: string) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h);
  const local = isLocal(new URL(origin).host) && isLocal(host);
  if (new URL(origin).host !== host && !local) throw new HttpError(400, 'bad_origin', 'Open Darkspace at its own address and try again.');
  return origin;
}

async function requireMember(user: User, workspaceId: string, admin = false) {
  const ok = await asAuthenticated(user, async (client) => {
    const r = await client.query(
      admin
        ? 'SELECT public.user_is_workspace_admin($1::uuid, auth.uid()) AS ok'
        : 'SELECT public.user_is_workspace_member($1::uuid, auth.uid()) AS ok',
      [workspaceId],
    );
    return !!r.rows[0]?.ok;
  });
  if (!ok) throw new HttpError(403, 'forbidden', admin ? 'Only workspace owners and admins can connect GitHub.' : 'You are not a member of this workspace.');
}

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const workspaceId = uuid.parse(new URL(request.url).searchParams.get('workspace_id'));
    await requireMember(user, workspaceId);
    const c = await connectionFor(workspaceId).catch(() => null);
    const app = await appConfig().catch(() => null);
    const accounts = await accountsOf(user.id);
    return json({
      connected: !!c || accounts.length > 0, login: c?.login ?? null, connected_at: c?.connected_at ?? null,
      app: app ? { slug: app.slug, html_url: app.html_url } : null,
      accounts,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const body = await readJson(request, Body);
    switch (body.action) {
      case 'connect':
        await requireMember(user, body.workspace_id, true);
        return json(await connect(body.workspace_id, user.id, body.token));
      case 'disconnect':
        await requireMember(user, body.workspace_id, true);
        await disconnect(body.workspace_id);
        return json({ connected: false });
      case 'repos':
        await requireMember(user, body.workspace_id);
        if (body.account_id) { await ownAccount(user.id, body.account_id); return json({ repos: await listAccountRepos(body.account_id) }); }
        return json({ repos: await listRepos(body.workspace_id) });
      case 'create_project':
        await requireMember(user, body.workspace_id);
        if (body.account_id) await ownAccount(user.id, body.account_id);
        return json(await createProjectFromRepo(body.workspace_id, user.id, body.repo, body.account_id));
      case 'app_manifest': {
        await requireMember(user, body.workspace_id, true);
        const origin = checkedOrigin(request, body.origin);
        const state = signState({ k: 'app', u: user.id, o: origin });
        return json({ action: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`, manifest: appManifest(origin) });
      }
      case 'authorize': {
        const app = await appConfig();
        if (!app) throw new HttpError(400, 'github_app_missing', 'An admin needs to set up GitHub sign-in first.');
        const origin = checkedOrigin(request, body.origin);
        return json({ url: authorizeUrl(app, signState({ k: 'connect', u: user.id, o: origin })) });
      }
      case 'disconnect_account':
        await databasePool().query('DELETE FROM public.user_github_accounts WHERE id = $1 AND user_id = $2', [body.account_id, user.id]);
        return json({ ok: true });
      case 'review': {
        // The caller must be able to see the project.
        const visible = await asAuthenticated(user, async (client) =>
          (await client.query('SELECT 1 FROM public.project_github_links WHERE project_id = $1', [body.project_id])).rowCount);
        if (!visible) throw new HttpError(404, 'not_found', 'Project not found.');
        const result = await reviewProject(body.project_id);
        await databasePool().query(
          `UPDATE public.project_github_links SET last_review_on = (now() AT TIME ZONE timezone)::date
            WHERE project_id = $1 AND extract(dow FROM now() AT TIME ZONE timezone) = review_weekday`, [body.project_id]);
        return json(result);
      }
    }
  } catch (err) {
    return errorResponse(err);
  }
}
