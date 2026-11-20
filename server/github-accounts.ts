// Connected accounts: people sign in with GitHub, like VS Code's "Accounts",
// through a Darkspace GitHub App. The app is registered once per server with
// GitHub's manifest flow (one click for an admin); it only has read access to
// contents, issues and metadata. Tokens are sealed and refreshed by the server.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { databasePool } from './database.js';
import { HttpError } from './http.js';
import { API, gh, key, openToken, sealToken, type RepoSummary } from './github.js';

export interface AppConfig { app_id: number; slug: string; client_id: string; client_secret: string; origin: string; html_url: string | null }
export interface StateBody { k: 'app' | 'connect'; u: string; o: string; exp: number }

/** A short-lived, signed value carried through GitHub's redirects. */
export function signState(body: Omit<StateBody, 'exp'>): string {
  const payload = Buffer.from(JSON.stringify({ ...body, exp: Date.now() + 15 * 60_000 })).toString('base64url');
  const mac = createHmac('sha256', key()).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function readState(state: string | null): StateBody {
  const [payload, mac] = (state ?? '').split('.');
  if (!payload || !mac) throw new HttpError(400, 'bad_state', 'This GitHub link has expired. Start again from Connected accounts.');
  const expected = createHmac('sha256', key()).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(400, 'bad_state', 'This GitHub link is not valid.');
  const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as StateBody;
  if (body.exp < Date.now()) throw new HttpError(400, 'bad_state', 'This GitHub link has expired. Start again from Connected accounts.');
  return body;
}

export async function appConfig(): Promise<AppConfig | null> {
  const r = await databasePool().query('SELECT app_id, slug, client_id, secrets_sealed, origin, html_url FROM public.github_app_config WHERE id = 1');
  if (!r.rowCount) return null;
  const row = r.rows[0];
  const secrets = JSON.parse(openToken(row.secrets_sealed)) as { client_secret: string };
  return { app_id: Number(row.app_id), slug: row.slug, client_id: row.client_id, client_secret: secrets.client_secret, origin: row.origin, html_url: row.html_url };
}

/** The manifest GitHub uses to register the Darkspace app in one click. */
export function appManifest(origin: string) {
  const host = new URL(origin).host;
  return {
    name: `Darkspace ${host.split('.')[0]}`.slice(0, 34),
    url: origin,
    description: 'Darkspace project agent: reads repositories, issues and commits to keep project tasks up to date. Read-only.',
    hook_attributes: { url: `${origin}/api/github/webhook`, active: false },
    redirect_url: `${origin}/api/github/app-created`,
    callback_urls: [`${origin}/api/github/callback`],
    setup_url: `${origin}/api/github/callback`,
    setup_on_update: true,
    request_oauth_on_install: true,
    public: true,
    default_permissions: { contents: 'read', issues: 'read', metadata: 'read' },
    default_events: [],
  };
}

/** Finishes the manifest flow: GitHub hands back the new app's credentials once. */
export async function saveCreatedApp(code: string, userId: string, origin: string): Promise<AppConfig> {
  const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'darkspace-project-agent' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new HttpError(502, 'github_app_failed', 'GitHub did not confirm the new app. Try the setup again.');
  const app = await res.json() as { id: number; slug: string; client_id: string; client_secret: string; pem: string; webhook_secret: string | null; html_url: string };
  const sealed = sealToken(JSON.stringify({ client_secret: app.client_secret, pem: app.pem, webhook_secret: app.webhook_secret }));
  await databasePool().query(
    `INSERT INTO public.github_app_config (id, app_id, slug, client_id, secrets_sealed, html_url, origin, created_by)
     VALUES (1, $1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET app_id = excluded.app_id, slug = excluded.slug, client_id = excluded.client_id,
       secrets_sealed = excluded.secrets_sealed, html_url = excluded.html_url, origin = excluded.origin,
       created_by = excluded.created_by, created_at = now()`,
    [app.id, app.slug, app.client_id, JSON.stringify(sealed), app.html_url, origin, userId],
  );
  return { app_id: app.id, slug: app.slug, client_id: app.client_id, client_secret: app.client_secret, origin, html_url: app.html_url };
}

export const installUrl = (app: AppConfig, state: string) =>
  `https://github.com/apps/${app.slug}/installations/new?state=${encodeURIComponent(state)}`;

/** `pickAccount` shows GitHub's account chooser, so another account can be added. */
export const authorizeUrl = (app: AppConfig, state: string, pickAccount = false) =>
  `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(app.client_id)}&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(`${app.origin}/api/github/callback`)}${pickAccount ? '&prompt=select_account' : ''}`;

interface TokenSet { access_token: string; refresh_token?: string; expires_in?: number }

async function oauthToken(app: AppConfig, params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'darkspace-project-agent' },
    body: JSON.stringify({ client_id: app.client_id, client_secret: app.client_secret, ...params }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as TokenSet & { error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new HttpError(400, 'github_sign_in_failed', data.error_description ?? 'GitHub sign-in did not complete. Try again.');
  return data;
}

const expiry = (t: TokenSet) => (t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null);

/** Exchanges the sign-in code and saves (or refreshes) the person's account. */
export async function saveAccountFromCode(app: AppConfig, userId: string, code: string): Promise<{ login: string; installations: number }> {
  const tokens = await oauthToken(app, { code });
  const me = await gh<{ id: number; login: string; name: string | null; avatar_url: string }>(tokens.access_token, '/user');
  await databasePool().query(
    `INSERT INTO public.user_github_accounts (user_id, github_id, login, name, avatar_url, token_sealed, token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (user_id, github_id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url,
       token_sealed = excluded.token_sealed, token_expires_at = excluded.token_expires_at, updated_at = now()`,
    [userId, me.id, me.login, me.name, me.avatar_url, JSON.stringify(sealToken(JSON.stringify(tokens))), expiry(tokens)],
  );
  const installations = await gh<{ total_count: number }>(tokens.access_token, '/user/installations?per_page=1');
  return { login: me.login, installations: installations.total_count };
}

/** A working token for a connected account, refreshed when it is about to expire. */
export async function accountToken(accountId: string): Promise<string> {
  const r = await databasePool().query('SELECT token_sealed, token_expires_at FROM public.user_github_accounts WHERE id = $1', [accountId]);
  if (!r.rowCount) throw new HttpError(400, 'github_account_missing', 'The GitHub account for this project was disconnected. Connect it again in Settings → Connected accounts.');
  const tokens = JSON.parse(openToken(r.rows[0].token_sealed)) as TokenSet;
  const expires = r.rows[0].token_expires_at ? new Date(r.rows[0].token_expires_at).getTime() : null;
  if (!expires || expires - Date.now() > 5 * 60_000 || !tokens.refresh_token) return tokens.access_token;
  const app = await appConfig();
  if (!app) throw new HttpError(400, 'github_app_missing', 'GitHub sign-in is not set up on this server.');
  const fresh = await oauthToken(app, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  await databasePool().query(
    'UPDATE public.user_github_accounts SET token_sealed = $2::jsonb, token_expires_at = $3, updated_at = now() WHERE id = $1',
    [accountId, JSON.stringify(sealToken(JSON.stringify(fresh))), expiry(fresh)],
  );
  return fresh.access_token;
}

export async function ownAccount(userId: string, accountId: string): Promise<void> {
  const r = await databasePool().query('SELECT 1 FROM public.user_github_accounts WHERE id = $1 AND user_id = $2', [accountId, userId]);
  if (!r.rowCount) throw new HttpError(403, 'forbidden', 'That GitHub account is not connected to you.');
}

export async function accountsOf(userId: string) {
  const r = await databasePool().query(
    'SELECT id, github_id, login, name, avatar_url, created_at FROM public.user_github_accounts WHERE user_id = $1 ORDER BY created_at',
    [userId],
  );
  return r.rows as Array<{ id: string; github_id: number; login: string; name: string | null; avatar_url: string | null; created_at: string }>;
}

/** Repositories the account's installations of the app can read. */
export async function listAccountRepos(accountId: string): Promise<RepoSummary[]> {
  const token = await accountToken(accountId);
  const installs = await gh<{ installations: Array<{ id: number }> }>(token, '/user/installations?per_page=100');
  const out: RepoSummary[] = [];
  for (const i of installs.installations) {
    const page = await gh<{ repositories: RepoSummary[] }>(token, `/user/installations/${i.id}/repositories?per_page=100`);
    out.push(...page.repositories);
  }
  return out
    .sort((a, b) => (b.pushed_at ?? '').localeCompare(a.pushed_at ?? ''))
    .map((r) => ({ full_name: r.full_name, description: r.description, private: r.private, default_branch: r.default_branch, html_url: r.html_url, pushed_at: r.pushed_at, open_issues_count: r.open_issues_count }));
}
