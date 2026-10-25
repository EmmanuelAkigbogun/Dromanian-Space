// ONLYOFFICE Document Server integration. Editor configs are signed with
// ONLYOFFICE_JWT_SECRET (the Document Server rejects anything else), and the
// file/callback URLs it calls carry short-lived signed tokens of our own.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';

export type DocumentType = 'word' | 'cell' | 'slide';

const TYPES: Record<string, { type: DocumentType; editable: boolean }> = {
  docx: { type: 'word', editable: true },
  docm: { type: 'word', editable: true },
  dotx: { type: 'word', editable: true },
  odt: { type: 'word', editable: true },
  rtf: { type: 'word', editable: true },
  txt: { type: 'word', editable: true },
  doc: { type: 'word', editable: false },
  xlsx: { type: 'cell', editable: true },
  xlsm: { type: 'cell', editable: true },
  xltx: { type: 'cell', editable: true },
  ods: { type: 'cell', editable: true },
  csv: { type: 'cell', editable: true },
  xls: { type: 'cell', editable: false },
  pptx: { type: 'slide', editable: true },
  pptm: { type: 'slide', editable: true },
  potx: { type: 'slide', editable: true },
  odp: { type: 'slide', editable: true },
  ppsx: { type: 'slide', editable: true },
  ppt: { type: 'slide', editable: false },
};

export function officeType(extension: string) {
  return TYPES[extension] ?? null;
}

export function officeSettings() {
  const secret = process.env.ONLYOFFICE_JWT_SECRET?.trim();
  if (!secret) return null;
  return {
    secret,
    /** How the API reaches the Document Server (private network). */
    internalUrl: (process.env.ONLYOFFICE_INTERNAL_URL?.trim() || 'http://onlyoffice').replace(/\/$/, ''),
    /** How the Document Server reaches the API (private network). */
    appUrl: (process.env.APP_INTERNAL_URL?.trim() || 'http://api:3000').replace(/\/$/, ''),
    /** Where browsers load the editor from (same origin, proxied by the web container). */
    publicPath: '/office',
  };
}

export function requireOffice() {
  const settings = officeSettings();
  if (!settings) throw new HttpError(503, 'not_configured', 'Office editing is not set up on this server.');
  return settings;
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

export function signJwt(payload: object, secret: string): string {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify(payload));
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

export function verifyJwt<T = Record<string, unknown>>(token: string, secret: string): T | null {
  const [head, body, signature] = token.split('.');
  if (!head || !body || !signature) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url'));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') return null;
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
    if (typeof claims.exp === 'number' && claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}

export interface LinkClaims {
  purpose: 'file' | 'callback';
  item: string;
  version: string;
  user: string;
  exp: number;
}

/** A token for one purpose, item version and person, valid for a working day. */
export function linkToken(claims: Omit<LinkClaims, 'exp'>, secret: string): string {
  return signJwt({ ...claims, exp: Math.floor(Date.now() / 1000) + 12 * 3600 }, `${secret}:links`);
}

export function readLinkToken(token: string | null, purpose: LinkClaims['purpose'], secret: string): LinkClaims {
  const claims = token ? verifyJwt<LinkClaims>(token, `${secret}:links`) : null;
  if (!claims || claims.purpose !== purpose) throw new HttpError(403, 'forbidden', 'Invalid or expired link.');
  return claims;
}
