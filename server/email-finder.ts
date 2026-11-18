// Finds work email addresses for CRM contacts.
//
// 1. Reads the company's public website through the private Crawl4AI scraper
//    (home page plus its contact / team / about pages) and collects published
//    addresses at the company's domain. A published address that matches the
//    contact's name is taken as verified, and published personal addresses
//    teach the domain's naming pattern (first.last@, f.last@, …).
// 2. When the private Reacher sidecar (reacherhq/check-if-email-exists) is
//    deployed, asks the domain's mail server, without sending any email,
//    whether candidate mailboxes exist. Catch-all domains accept every
//    address, so there a candidate is only "likely" and only when the pattern
//    is already known.
//
// Probes are sequential and throttled; nothing here runs unless a person
// starts it from the CRM.
import { resolveMx } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertPublicWebUrl, browserScraperConnection } from './agents/tools/browser.js';

export const EMAIL_STATUS = {
  verified: 'Verified',
  likelyCatchAll: 'Likely (catch-all domain)',
  likelyPattern: 'Likely (company pattern)',
  notFound: 'Not found',
  noMail: 'Domain has no mail server',
  unverifiable: 'Mail server would not answer',
} as const;
export type EmailStatus = (typeof EMAIL_STATUS)[keyof typeof EMAIL_STATUS];

export interface EmailResult {
  email: string | null;
  status: EmailStatus;
  evidence: string;
}

// ── Names and candidate addresses ───────────────────────────────────────────

const HONORIFICS = new Set(['dr', 'ing', 'prof', 'mr', 'mrs', 'ms', 'phd', 'mba', 'emba', 'mrics', 'cmgr', 'pmp', 'cfa', 'acca', 'msc', 'bsc', 'arh', 'ec', 'av', 'jr', 'sr']);

export function asciiFold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[ßẞ]/g, 'ss').replace(/[łŁ]/g, 'l').toLowerCase();
}

/** Name parts for address building: honorifics, credentials and anything after a comma dropped. */
export function nameParts(fullName: string): string[] {
  const cleaned = fullName.split(',')[0].replace(/\(.*?\)/g, ' ');
  return asciiFold(cleaned)
    .split(/\s+/)
    .map((p) => p.replace(/[^a-z-]/g, '').replace(/^-+|-+$/g, ''))
    .filter((p) => p && !HONORIFICS.has(p.replace(/-/g, '')) && p.length > 1);
}

/** Local-part templates, most common first. */
export const PATTERNS = ['first.last', 'first', 'f.last', 'firstlast', 'flast', 'last.first', 'last', 'first_last', 'first-last', 'lastf', 'last.f', 'first.l'] as const;
export type Pattern = (typeof PATTERNS)[number];

function render(pattern: Pattern, first: string, last: string): string {
  const f = first[0], l = last[0];
  switch (pattern) {
    case 'first.last': return `${first}.${last}`;
    case 'first': return first;
    case 'f.last': return `${f}.${last}`;
    case 'firstlast': return `${first}${last}`;
    case 'flast': return `${f}${last}`;
    case 'last.first': return `${last}.${first}`;
    case 'last': return last;
    case 'first_last': return `${first}_${last}`;
    case 'first-last': return `${first}-${last}`;
    case 'lastf': return `${last}${f}`;
    case 'last.f': return `${last}.${f}`;
    case 'first.l': return `${first}.${l}`;
  }
}

export interface Candidate { email: string; pattern: Pattern; reversed: boolean }

/**
 * Candidate addresses in probing order. Romanian lists often put the family
 * name first, so the reversed reading follows the natural one; hyphenated
 * given names are tried whole, joined and by their first part.
 */
export function candidates(fullName: string, domain: string, preferred?: Pattern | null): Candidate[] {
  const parts = nameParts(fullName);
  if (parts.length < 2) return [];
  const readings: Array<{ first: string; last: string; reversed: boolean }> = [];
  const add = (first: string, last: string, reversed: boolean) => {
    for (const f of new Set([first.split('-')[0], first.replace(/-/g, ''), first])) {
      for (const l of new Set([last.replace(/-/g, ''), last.split('-')[0], last])) {
        if (f && l && !readings.some((r) => r.first === f && r.last === l)) readings.push({ first: f, last: l, reversed });
      }
    }
  };
  add(parts[0], parts[parts.length - 1], false);
  add(parts[parts.length - 1], parts[0], true);
  const order = preferred ? [preferred, ...PATTERNS.filter((p) => p !== preferred)] : [...PATTERNS];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const pattern of order) {
    for (const r of readings) {
      const local = render(pattern, r.first, r.last);
      if (!/^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/.test(local) || local.includes('..')) continue;
      const email = `${local}@${domain}`;
      if (!seen.has(email)) { seen.add(email); out.push({ email, pattern, reversed: r.reversed }); }
    }
  }
  return out;
}

/** Which pattern (if any) produces this local part for this name. */
export function patternOf(email: string, fullName: string, domain: string): Pattern | null {
  return candidates(fullName, domain).find((c) => c.email === email.toLowerCase())?.pattern ?? null;
}

export function domainOf(website: string | null | undefined): string | null {
  if (!website?.trim()) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

// ── Website reading (Crawl4AI) ──────────────────────────────────────────────

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const PAGE_HINT = /(contact|kontakt|echip|team|despre|about|conducere|management|leadership|people|oameni)/i;

async function readPage(url: string, signal: AbortSignal): Promise<string> {
  const connection = browserScraperConnection();
  if (!connection) return '';
  const target = await assertPublicWebUrl(url);
  const response = await fetch(`${connection.baseUrl}/md`, {
    method: 'POST',
    headers: { accept: 'application/json', authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: target.toString(), f: 'raw' }),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
  });
  if (!response.ok) { await response.body?.cancel(); return ''; }
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) return '';
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { markdown?: unknown }).markdown === 'string') return (parsed as { markdown: string }).markdown;
  } catch { /* not JSON */ }
  return '';
}

/** Addresses at the company's domain published on its home, contact and team pages. */
export async function publishedEmails(domain: string, signal: AbortSignal, maxPages = 5): Promise<Set<string>> {
  const found = new Set<string>();
  if (!browserScraperConnection()) return found;
  const collect = (markdown: string) => {
    for (const raw of markdown.replace(/\[at\]|\(at\)/gi, '@').match(EMAIL_RE) ?? []) {
      const email = raw.toLowerCase().replace(/\.+$/, '');
      const host = email.split('@')[1];
      if (host === domain || host.endsWith(`.${domain}`)) found.add(email);
    }
  };
  const home = `https://${domain}/`;
  let homeMarkdown = '';
  try { homeMarkdown = await readPage(home, signal); } catch { /* unreachable site */ }
  if (signal.aborted) return found;
  collect(homeMarkdown);
  const links = new Set<string>();
  for (const m of homeMarkdown.matchAll(/\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g)) {
    try {
      const url = new URL(m[1], home);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      if ((host === domain || host.endsWith(`.${domain}`)) && PAGE_HINT.test(url.pathname)) { url.hash = ''; links.add(url.toString()); }
    } catch { /* bad link */ }
  }
  for (const path of ['contact', 'contact-us', 'contacte', 'kontakt']) links.add(`https://${domain}/${path}`);
  for (const url of [...links].slice(0, maxPages - 1)) {
    if (signal.aborted) break;
    try { collect(await readPage(url, signal)); } catch { /* skip page */ }
  }
  return found;
}

// ── Mailbox verification (Reacher) ──────────────────────────────────────────

interface VerifierConnection { baseUrl: string; token: string }

export function emailVerifierConnection(source: NodeJS.ProcessEnv = process.env): VerifierConnection | null {
  const baseUrl = source.EMAIL_VERIFIER_URL?.trim().replace(/\/+$/, '');
  let token = source.EMAIL_VERIFIER_TOKEN?.trim() ?? '';
  if (!token && source.EMAIL_VERIFIER_TOKEN_FILE?.trim()) {
    try { token = readFileSync(source.EMAIL_VERIFIER_TOKEN_FILE.trim(), 'utf8').trim(); } catch { token = ''; }
  }
  if (!baseUrl || !token) return null;
  try {
    const url = new URL(baseUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  } catch { return null; }
  return { baseUrl, token };
}

export type Reachability = 'safe' | 'risky' | 'invalid' | 'unknown';
export interface MailboxCheck { reachable: Reachability; catchAll: boolean | null; acceptsMail: boolean | null }

export async function checkMailbox(email: string, signal: AbortSignal, connection = emailVerifierConnection()): Promise<MailboxCheck> {
  if (!connection) throw new Error('email_verifier_not_configured');
  const response = await fetch(`${connection.baseUrl}/v0/check_email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-reacher-secret': connection.token, authorization: connection.token },
    body: JSON.stringify({ to_email: email }),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 || response.status === 400 ? 'email_verifier_rejected' : `email_verifier_http_${response.status}`);
  }
  const body = await response.json() as {
    is_reachable?: string;
    smtp?: { is_catch_all?: boolean };
    mx?: { accepts_mail?: boolean };
  };
  const reachable = (['safe', 'risky', 'invalid', 'unknown'] as const).find((v) => v === body.is_reachable) ?? 'unknown';
  return {
    reachable,
    catchAll: typeof body.smtp?.is_catch_all === 'boolean' ? body.smtp.is_catch_all : null,
    acceptsMail: typeof body.mx?.accepts_mail === 'boolean' ? body.mx.accepts_mail : null,
  };
}

// ── Per-domain search ───────────────────────────────────────────────────────

export interface FinderContact { id: string; name: string }
export interface FinderOptions {
  signal: AbortSignal;
  /** Called after each contact so results are saved as they arrive. */
  onResult: (contact: FinderContact, result: EmailResult) => Promise<void>;
  maxProbesPerContact?: number;
  probeDelayMs?: number;
  /** Test seams. */
  check?: (email: string, signal: AbortSignal) => Promise<MailboxCheck>;
  published?: (domain: string, signal: AbortSignal) => Promise<Set<string>>;
  hasMx?: (domain: string) => Promise<boolean>;
  verifierAvailable?: boolean;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted || ms <= 0) return resolve();
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

async function domainHasMx(domain: string): Promise<boolean> {
  try { return (await resolveMx(domain)).length > 0; } catch { return false; }
}

/** Finds addresses for contacts who all work at one company domain. */
export async function findEmailsForDomain(domain: string, contacts: FinderContact[], options: FinderOptions): Promise<void> {
  const { signal } = options;
  const maxProbes = options.maxProbesPerContact ?? 6;
  const delay = options.probeDelayMs ?? 1500;
  const check = options.check ?? ((email: string, s: AbortSignal) => checkMailbox(email, s));
  const verifier = options.verifierAvailable ?? emailVerifierConnection() !== null;
  const pending = new Map(contacts.map((c) => [c.id, c]));
  const finish = async (c: FinderContact, result: EmailResult) => { pending.delete(c.id); await options.onResult(c, result); };

  if (!(await (options.hasMx ?? domainHasMx)(domain))) {
    for (const c of contacts) await finish(c, { email: null, status: EMAIL_STATUS.noMail, evidence: `${domain} has no MX record` });
    return;
  }

  // Website: exact published matches, and the domain pattern from them.
  const published = await (options.published ?? publishedEmails)(domain, signal).catch(() => new Set<string>());
  const votes = new Map<Pattern, number>();
  for (const email of published) {
    for (const c of contacts) {
      const p = patternOf(email, c.name, domain);
      if (p && p !== 'first' && p !== 'last') votes.set(p, (votes.get(p) ?? 0) + 1);
    }
  }
  let pattern: Pattern | null = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  for (const c of contacts) {
    if (signal.aborted) return;
    const hit = candidates(c.name, domain).find((cand) => published.has(cand.email));
    if (hit) await finish(c, { email: hit.email, status: EMAIL_STATUS.verified, evidence: `Published on ${domain}` });
  }
  if (!pending.size) return;

  if (!verifier) {
    for (const c of [...pending.values()]) {
      const guess = pattern ? candidates(c.name, domain, pattern)[0] : null;
      await finish(c, guess
        ? { email: guess.email, status: EMAIL_STATUS.likelyPattern, evidence: `Pattern ${pattern} from addresses published on ${domain}; not verified` }
        : { email: null, status: EMAIL_STATUS.notFound, evidence: `No matching address published on ${domain}` });
    }
    return;
  }

  // Catch-all test: a mailbox that cannot exist.
  let catchAll: boolean | null = null;
  try {
    const probe = await check(`no-such-person-${randomBytes(5).toString('hex')}@${domain}`, signal);
    catchAll = probe.catchAll ?? (probe.reachable === 'invalid' ? false : probe.reachable === 'safe' || probe.reachable === 'risky' ? true : null);
  } catch (err) {
    if (signal.aborted) return;
    if (err instanceof Error && err.message === 'email_verifier_rejected') throw err;
  }
  if (catchAll !== false) {
    for (const c of [...pending.values()]) {
      const guess = pattern ? candidates(c.name, domain, pattern)[0] : null;
      if (guess) await finish(c, { email: guess.email, status: EMAIL_STATUS.likelyCatchAll, evidence: `${domain} accepts every address; pattern ${pattern} from its website` });
      else await finish(c, catchAll
        ? { email: null, status: EMAIL_STATUS.notFound, evidence: `${domain} accepts every address, so mailboxes cannot be confirmed` }
        : { email: null, status: EMAIL_STATUS.unverifiable, evidence: `The mail server for ${domain} did not give a clear answer` });
    }
    return;
  }

  for (const c of [...pending.values()]) {
    if (signal.aborted) return;
    let found: Candidate | null = null;
    let unknown = 0;
    for (const cand of candidates(c.name, domain, pattern).slice(0, maxProbes)) {
      if (signal.aborted) return;
      await sleep(delay, signal);
      let result: MailboxCheck;
      try { result = await check(cand.email, signal); } catch (err) {
        if (signal.aborted) return;
        if (err instanceof Error && err.message === 'email_verifier_rejected') throw err;
        unknown++;
        continue;
      }
      if (result.reachable === 'safe') { found = cand; break; }
      if (result.reachable === 'unknown') unknown++;
    }
    if (found) {
      pattern = found.pattern;
      await finish(c, { email: found.email, status: EMAIL_STATUS.verified, evidence: `Mail server for ${domain} confirmed the mailbox` });
    } else {
      await finish(c, unknown
        ? { email: null, status: EMAIL_STATUS.unverifiable, evidence: `The mail server for ${domain} did not answer for ${unknown} candidate address(es)` }
        : { email: null, status: EMAIL_STATUS.notFound, evidence: `None of the usual address patterns exist at ${domain}` });
    }
  }
}
