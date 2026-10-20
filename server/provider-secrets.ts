// Runtime AI credentials entered in the admin UI. Values are encrypted before
// they are written to the shared server storage volume; callers can only read
// them inside the API/worker containers.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type RuntimeProvider = 'anthropic' | 'openai';

interface SealedValue {
  iv: string;
  tag: string;
  ciphertext: string;
}

interface SecretFile {
  version: 1;
  providers: Partial<Record<RuntimeProvider, SealedValue>>;
}

const root = path.resolve(process.env.STORAGE_ROOT?.trim() ?? '/data/storage');
const directory = path.join(root, '.config');
const filename = path.join(directory, 'ai-provider-keys.json');
let writes: Promise<void> = Promise.resolve();

function encryptionKey(): Buffer {
  const secret = process.env.APP_JWT_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error('APP_JWT_SECRET is required to protect provider keys.');
  return createHash('sha256').update(`dromanian-ai-provider-keys:${secret}`).digest();
}

function emptyFile(): SecretFile {
  return { version: 1, providers: {} };
}

function readSecretFile(): SecretFile {
  try {
    const parsed = JSON.parse(readFileSync(filename, 'utf8')) as SecretFile;
    return parsed?.version === 1 && parsed.providers && typeof parsed.providers === 'object' ? parsed : emptyFile();
  } catch (error: any) {
    if (error?.code === 'ENOENT') return emptyFile();
    throw error;
  }
}

export function sealProviderKey(provider: RuntimeProvider, value: string): SealedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`provider:${provider}:v1`));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function openProviderKey(provider: RuntimeProvider, sealed: SealedValue): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(`provider:${provider}:v1`));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export function savedProviderKey(provider: RuntimeProvider): string | null {
  try {
    const sealed = readSecretFile().providers[provider];
    return sealed ? openProviderKey(provider, sealed) : null;
  } catch {
    // A rotated APP_JWT_SECRET or damaged file must not stop the API from
    // starting. The platform admin can replace the unreadable saved key.
    return null;
  }
}

export function providerApiKey(provider: RuntimeProvider): string | null {
  const saved = savedProviderKey(provider)?.trim();
  if (saved) return saved;
  const environmentName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  return process.env[environmentName]?.trim() || null;
}

export function providerKeySource(provider: RuntimeProvider): 'saved' | 'environment' | 'none' {
  if (savedProviderKey(provider)) return 'saved';
  const environmentName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  return process.env[environmentName]?.trim() ? 'environment' : 'none';
}

async function updateFile(change: (file: SecretFile) => void): Promise<void> {
  const run = writes.then(async () => {
    const current = readSecretFile();
    change(current);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(current)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await rename(temporary, filename);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  writes = run.catch(() => undefined);
  return run;
}

export async function saveProviderKey(provider: RuntimeProvider, value: string): Promise<void> {
  await updateFile((file) => { file.providers[provider] = sealProviderKey(provider, value.trim()); });
}

export async function removeProviderKey(provider: RuntimeProvider): Promise<void> {
  await updateFile((file) => { delete file.providers[provider]; });
}
