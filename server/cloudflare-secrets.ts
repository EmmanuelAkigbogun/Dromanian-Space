import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CloudflareConnection {
  apiToken: string;
  accountId: string;
  tunnelId?: string;
  defaultService?: string;
}

interface Sealed { iv: string; tag: string; ciphertext: string }
interface Stored { version: 1; connection: Sealed }

const root = path.resolve(process.env.STORAGE_ROOT?.trim() ?? '/data/storage');
const directory = path.join(root, '.config');
const filename = path.join(directory, 'cloudflare.json');
let writes: Promise<void> = Promise.resolve();

function key(): Buffer {
  const secret = process.env.APP_JWT_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error('APP_JWT_SECRET is required to protect Cloudflare credentials.');
  return createHash('sha256').update(`dromanian-cloudflare:v1:${secret}`).digest();
}

export function sealCloudflareConnection(value: CloudflareConnection): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from('cloudflare-connection:v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function openCloudflareConnection(sealed: Sealed): CloudflareConnection {
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from('cloudflare-connection:v1'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as CloudflareConnection;
}

export async function savedCloudflareConnection(): Promise<CloudflareConnection | null> {
  try {
    const stored = JSON.parse(await readFile(filename, 'utf8')) as Stored;
    return stored.version === 1 ? openCloudflareConnection(stored.connection) : null;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return environmentConnection();
    return null;
  }
}

function environmentConnection(): CloudflareConnection | null {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!apiToken || !accountId) return null;
  return {
    apiToken,
    accountId,
    tunnelId: process.env.CLOUDFLARE_TUNNEL_ID?.trim() || undefined,
    defaultService: process.env.CLOUDFLARE_TUNNEL_SERVICE?.trim() || undefined,
  };
}

export async function saveCloudflareConnection(value: CloudflareConnection): Promise<void> {
  const run = writes.then(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, connection: sealCloudflareConnection(value) })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { await rename(temporary, filename); }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  });
  writes = run.catch(() => undefined);
  return run;
}

export async function removeCloudflareConnection(): Promise<void> {
  await rm(filename, { force: true });
}
