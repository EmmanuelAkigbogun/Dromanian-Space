// Social posting with profullstack/social-poster (MIT): browser automation
// against each network's own website, using the account's saved login.
//
// Logging in happens in a remote browser the person drives from the app
// (screenshots out, clicks and keys in), so two-step verification and
// captchas work. The browser may only reach that network's own sites and the
// sign-in providers it uses, never our internal services. Sessions are
// encrypted with a key derived from APP_JWT_SECRET before they are stored.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, CDPSession, Cookie, Page } from 'puppeteer';
import { databasePool } from './database.js';
import { env } from './env.js';
import { HttpError } from './http.js';
import { log } from './log.js';

export type Platform = 'x' | 'linkedin' | 'facebook' | 'pinterest' | 'tiktok';

interface PlatformInfo {
  label: string;
  home: string;
  login: string;
  domains: string[];
  maxLength: number;
}

export const PLATFORMS: Record<Platform, PlatformInfo> = {
  x: { label: 'X', home: 'https://x.com/home', login: 'https://x.com/i/flow/login', domains: ['x.com', 'twitter.com', 'twimg.com', 't.co'], maxLength: 280 },
  linkedin: { label: 'LinkedIn', home: 'https://www.linkedin.com/feed/', login: 'https://www.linkedin.com/login', domains: ['linkedin.com', 'licdn.com'], maxLength: 3000 },
  facebook: { label: 'Facebook', home: 'https://www.facebook.com/', login: 'https://www.facebook.com/login', domains: ['facebook.com', 'fbcdn.net', 'facebook.net', 'fb.com'], maxLength: 63206 },
  pinterest: { label: 'Pinterest', home: 'https://www.pinterest.com/', login: 'https://www.pinterest.com/login/', domains: ['pinterest.com', 'pinimg.com'], maxLength: 500 },
  tiktok: { label: 'TikTok', home: 'https://www.tiktok.com/', login: 'https://www.tiktok.com/login', domains: ['tiktok.com', 'tiktokcdn.com', 'tiktokv.com', 'ttwstatic.com', 'byteoversea.com', 'ibytedtos.com'], maxLength: 2200 },
};

/** Sign-in providers, captcha and challenge services the networks embed. */
const SHARED_DOMAINS = [
  'google.com', 'gstatic.com', 'googleapis.com', 'recaptcha.net', 'hcaptcha.com', 'arkoselabs.com',
  'funcaptcha.com', 'cloudflare.com', 'challenges.cloudflare.com', 'apple.com', 'appleid.cdn-apple.com', 'cdn-apple.com',
];

export const isPlatform = (p: string): p is Platform => p in PLATFORMS;

export function allowedUrl(platform: Platform, url: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:') return false;
  if (parsed.port && parsed.port !== '443') return false;
  const host = parsed.hostname.toLowerCase();
  return [...PLATFORMS[platform].domains, ...SHARED_DOMAINS].some((d) => host === d || host.endsWith(`.${d}`));
}

// ── Session encryption ──────────────────────────────────────────────────────

function sessionKey(): Buffer {
  const secret = env().appJwtSecret;
  if (!secret) throw new HttpError(503, 'not_configured', 'Social posting needs APP_JWT_SECRET on the server.');
  return Buffer.from(hkdfSync('sha256', secret, 'darkspace-social', 'social-account-sessions', 32));
}

export function encryptSession(session: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decryptSession(ciphertext: string): SocialSession {
  const [version, iv, tag, body] = ciphertext.split('.');
  if (version !== 'v1') throw new Error('Unknown session format');
  const decipher = createDecipheriv('aes-256-gcm', sessionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'));
}

/** social-poster's session file format. */
export interface SocialSession {
  lastValidated: string;
  userAgent?: string;
  cookies: Cookie[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

// ── Browser ─────────────────────────────────────────────────────────────────

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const VIEWPORT = { width: 1280, height: 800 };
const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-zygote', '--disable-gpu', '--lang=en-US'];

export function browserPath(): string | undefined {
  return process.env.SOCIAL_BROWSER_PATH?.trim() || process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined;
}

export async function launchBrowser(): Promise<Browser> {
  const puppeteer = (await import('puppeteer')).default;
  return puppeteer.launch({ headless: true, executablePath: browserPath(), args: LAUNCH_ARGS, defaultViewport: VIEWPORT });
}

/** Keeps a page on the network's own sites, and adds what social-poster expects of older Puppeteer. */
export async function preparePage(page: Page, platform: Platform): Promise<Page> {
  await page.setUserAgent(USER_AGENT);
  await page.setViewport(VIEWPORT);
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.isInterceptResolutionHandled()) return;
    if (allowedUrl(platform, request.url())) void request.continue();
    else void request.abort('blockedbyclient');
  });
  // Removed in Puppeteer 22; social-poster still calls it.
  const legacy = page as Page & { waitForTimeout?: (ms: number) => Promise<void> };
  if (!legacy.waitForTimeout) legacy.waitForTimeout = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return page;
}

async function allCookies(page: Page): Promise<Cookie[]> {
  const client: CDPSession = await page.createCDPSession();
  try {
    const { cookies } = (await client.send('Network.getAllCookies')) as { cookies: Cookie[] };
    return cookies;
  } finally {
    await client.detach().catch(() => undefined);
  }
}

export async function captureSession(page: Page, platform: Platform): Promise<SocialSession> {
  const domains = PLATFORMS[platform].domains;
  const cookies = (await allCookies(page)).filter((c) => domains.some((d) => c.domain.replace(/^\./, '').endsWith(d)));
  const localStorage = await page.evaluate(() => Object.fromEntries(Object.entries(window.localStorage))).catch(() => ({}));
  return { lastValidated: new Date().toISOString(), userAgent: USER_AGENT, cookies, localStorage, sessionStorage: {} };
}

/** Opens the network's home page with a saved session; returns whether it shows as signed in. */
export async function checkSignedIn(page: Page, platform: Platform, session: SocialSession): Promise<boolean> {
  if (session.cookies.length) await page.setCookie(...session.cookies);
  await page.goto(PLATFORMS[platform].home, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 3000));
  const url = page.url();
  if (/\/(login|signin|i\/flow\/login|uas\/login|checkpoint)/i.test(url)) return false;
  return session.cookies.some((c) => /^(auth_token|li_at|c_user|_pinterest_sess|sessionid|sid_tt)$/i.test(c.name));
}

// ── Accounts ────────────────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  workspace_id: string;
  platform: Platform;
  label: string;
}

/** The account, when the person is an admin of its workspace. */
export async function accountForAdmin(userId: string, accountId: string): Promise<AccountRow> {
  const row = (await databasePool().query<AccountRow>(
    `SELECT a.id, a.workspace_id, a.platform, a.label FROM public.social_accounts a
      WHERE a.id = $1::uuid AND public.user_is_workspace_admin(a.workspace_id, $2::uuid)`,
    [accountId, userId])).rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'Account not found, or you are not an admin of its workspace.');
  return row;
}

export async function saveAccountSession(accountId: string, session: SocialSession, connected: boolean, error: string | null = null) {
  const db = databasePool();
  await db.query(
    `INSERT INTO public.social_account_sessions (account_id, ciphertext, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (account_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
    [accountId, encryptSession(session)]);
  await db.query(
    `UPDATE public.social_accounts SET status = $2, last_error = $3, connected_at = CASE WHEN $2 = 'connected' THEN now() ELSE connected_at END WHERE id = $1`,
    [accountId, connected ? 'connected' : 'needs_login', error]);
}

/** Cookies exported from a browser (Cookie-Editor, EditThisCookie, or Puppeteer's own format). */
export function normalizeCookies(input: unknown, platform: Platform): Cookie[] {
  if (!Array.isArray(input)) throw new HttpError(400, 'invalid_cookies', 'Paste the cookies as a JSON list.');
  const domains = PLATFORMS[platform].domains;
  const out: Cookie[] = [];
  for (const raw of input.slice(0, 300)) {
    const c = raw as Record<string, unknown>;
    const name = String(c.name ?? '');
    const value = String(c.value ?? '');
    const domain = String(c.domain ?? '');
    if (!name || !domain || !domains.some((d) => domain.replace(/^\./, '').endsWith(d))) continue;
    const expires = Number(c.expires ?? c.expirationDate ?? -1);
    const sameSite = String(c.sameSite ?? '').toLowerCase();
    out.push({
      name, value, domain, path: String(c.path ?? '/'),
      expires: Number.isFinite(expires) ? expires : -1,
      httpOnly: Boolean(c.httpOnly), secure: c.secure !== false,
      sameSite: sameSite === 'strict' ? 'Strict' : sameSite === 'lax' ? 'Lax' : 'None',
      size: name.length + value.length, session: !(expires > 0),
    } as Cookie);
  }
  if (!out.length) throw new HttpError(400, 'invalid_cookies', `No ${PLATFORMS[platform].label} cookies found in what you pasted.`);
  return out;
}

// ── Remote login ────────────────────────────────────────────────────────────

interface LoginSession {
  id: string;
  userId: string;
  account: AccountRow;
  browser: Browser;
  page: Page;
  lastUsed: number;
}

const logins = new Map<string, LoginSession>();
const IDLE_MS = 10 * 60_000;
const MAX_LOGINS = 3;

setInterval(() => {
  for (const s of logins.values()) if (Date.now() - s.lastUsed > IDLE_MS) void closeLogin(s.id);
}, 60_000).unref();

async function closeLogin(id: string) {
  const s = logins.get(id);
  logins.delete(id);
  await s?.browser.close().catch(() => undefined);
}

function loginFor(id: string, userId: string): LoginSession {
  const s = logins.get(id);
  if (!s || s.userId !== userId) throw new HttpError(404, 'not_found', 'This login window has closed. Start again.');
  s.lastUsed = Date.now();
  return s;
}

export async function startLogin(userId: string, accountId: string): Promise<{ id: string; width: number; height: number }> {
  const account = await accountForAdmin(userId, accountId);
  if (logins.size >= MAX_LOGINS) throw new HttpError(429, 'busy', 'Too many logins are open right now. Try again in a minute.');
  const browser = await launchBrowser().catch((err) => {
    log.warn('social browser launch failed', { error: err instanceof Error ? err.message : String(err) });
    throw new HttpError(503, 'no_browser', 'The server cannot start a browser for social logins.');
  });
  const page = await preparePage(await browser.newPage(), account.platform);
  const id = randomUUID();
  logins.set(id, { id, userId, account, browser, page, lastUsed: Date.now() });
  await page.goto(PLATFORMS[account.platform].login, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
  return { id, ...VIEWPORT };
}

export async function loginFrame(userId: string, id: string): Promise<Uint8Array> {
  const s = loginFor(id, userId);
  return s.page.screenshot({ type: 'jpeg', quality: 60 }) as Promise<Uint8Array>;
}

export type LoginInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; dy: number }
  | { type: 'back' };

const KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Space']);

export async function loginInput(userId: string, id: string, input: LoginInput): Promise<void> {
  const { page } = loginFor(id, userId);
  if (input.type === 'click') await page.mouse.click(Math.max(0, Math.min(VIEWPORT.width, input.x)), Math.max(0, Math.min(VIEWPORT.height, input.y)));
  else if (input.type === 'type') await page.keyboard.type(input.text.slice(0, 500), { delay: 30 });
  else if (input.type === 'key' && KEYS.has(input.key)) await page.keyboard.press(input.key === 'Space' ? ' ' : (input.key as 'Enter'));
  else if (input.type === 'scroll') await page.mouse.wheel({ deltaY: Math.max(-2000, Math.min(2000, input.dy)) });
  else if (input.type === 'back') await page.goBack({ timeout: 10_000 }).catch(() => undefined);
}

export async function finishLogin(userId: string, id: string): Promise<{ connected: boolean }> {
  const s = loginFor(id, userId);
  try {
    const session = await captureSession(s.page, s.account.platform);
    const check = await preparePage(await s.browser.newPage(), s.account.platform);
    const connected = await checkSignedIn(check, s.account.platform, session);
    if (!connected) throw new HttpError(409, 'not_signed_in', `This doesn’t look signed in to ${PLATFORMS[s.account.platform].label} yet. Finish signing in, then try again.`);
    await saveAccountSession(s.account.id, { ...session, cookies: await allCookies(check).then((all) => all.filter((c) => PLATFORMS[s.account.platform].domains.some((d) => c.domain.replace(/^\./, '').endsWith(d)))) }, true);
    await closeLogin(id);
    return { connected };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, 'login_failed', err instanceof Error ? err.message : 'The login could not be saved.');
  }
}

export const cancelLogin = (userId: string, id: string) => {
  loginFor(id, userId);
  return closeLogin(id);
};

/** Saves pasted cookies after checking they sign in. */
export async function saveCookies(userId: string, accountId: string, cookies: unknown): Promise<void> {
  const account = await accountForAdmin(userId, accountId);
  const session: SocialSession = { lastValidated: new Date().toISOString(), userAgent: USER_AGENT, cookies: normalizeCookies(cookies, account.platform), localStorage: {}, sessionStorage: {} };
  const browser = await launchBrowser().catch(() => null);
  if (!browser) {
    await saveAccountSession(account.id, session, true);
    return;
  }
  try {
    const page = await preparePage(await browser.newPage(), account.platform);
    const connected = await checkSignedIn(page, account.platform, session);
    if (!connected) throw new HttpError(409, 'not_signed_in', `These cookies don’t sign in to ${PLATFORMS[account.platform].label}. Export them again while signed in.`);
    await saveAccountSession(account.id, session, true);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// ── Publishing ──────────────────────────────────────────────────────────────

interface Poster {
  post(content: { text: string; link?: string }): Promise<{ success: boolean; error?: string; url?: string }>;
  closeBrowser?: () => Promise<void>;
  launchBrowser?: () => Promise<Browser>;
  createPage?: (platform: string) => Promise<Page>;
  browser?: Browser | null;
}

const CLASSES: Record<Exclude<Platform, 'facebook'>, string> = {
  x: 'XPlatform', linkedin: 'LinkedInPlatform', pinterest: 'PinterestPlatform', tiktok: 'TikTokPlatform',
};

let publishing: Promise<unknown> = Promise.resolve();

/** One browser at a time per worker: publishes run in turn. */
export function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const next = publishing.then(fn, fn);
  publishing = next.catch(() => undefined);
  return next;
}

/**
 * Publishes text (and a link) with a saved session; returns the session as it
 * stands afterwards, so refreshed cookies are kept.
 */
export async function publishWith(platform: Platform, session: SocialSession, content: { text: string; link?: string }) {
  const dir = await mkdtemp(join(tmpdir(), 'social-'));
  const sessionsPath = join(dir, 'sessions.json');
  // social-poster only restores sessions validated within the last day.
  await writeFile(sessionsPath, JSON.stringify({ [platform]: { ...session, lastValidated: new Date().toISOString() } }), { mode: 0o600 });
  let browser: Browser | null = null;
  try {
    if (platform === 'facebook') {
      const { FacebookPlatform } = await import('@profullstack/social-poster');
      browser = await launchBrowser();
      const page = await preparePage(await browser.newPage(), platform);
      if (session.cookies.length) await page.setCookie(...session.cookies);
      const fb = new FacebookPlatform({ headless: true, timeout: 45_000 }) as unknown as { post(page: Page, content: unknown): Promise<{ success: boolean; error?: string; url?: string }> };
      const outcome = await fb.post(page, content);
      return { ...outcome, session: { ...session, cookies: await allCookies(page).then((all) => all.filter((c) => PLATFORMS.facebook.domains.some((d) => c.domain.replace(/^\./, '').endsWith(d)))), lastValidated: new Date().toISOString() } };
    }
    const library = (await import('@profullstack/social-poster')) as unknown as Record<string, new (options: object) => Poster>;
    const poster = new library[CLASSES[platform]]({ headless: true, timeout: 45_000, sessionsPath, userAgent: USER_AGENT, viewport: VIEWPORT });
    // Our browser (system Chromium, guarded pages) instead of the library's.
    poster.launchBrowser = async () => (poster.browser ??= browser = await launchBrowser());
    const createPage = poster.createPage!.bind(poster);
    poster.createPage = async (name: string) => preparePage(await createPage(name), platform);
    const outcome = await poster.post(content);
    const saved = JSON.parse(await readFile(sessionsPath, 'utf8').catch(() => '{}'))[platform] as SocialSession | undefined;
    return { ...outcome, session: saved ?? session };
  } finally {
    await browser?.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
