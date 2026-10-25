// Server-side Drive file operations (unzip, office editor saves). Each step
// runs as the person it is for, through the same database functions a
// browser upload uses, so Drive's permission checks apply unchanged.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { asAuthenticated, type AuthUser } from './database.js';
import { HttpError } from './http.js';

const root = path.resolve(process.env.STORAGE_ROOT?.trim() ?? '/data/storage');
export const MAX_FILE_BYTES = Number(process.env.STORAGE_MAX_FILE_BYTES ?? 50 * 1024 * 1024);

function diskPath(bucket: string, objectPath: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(bucket) || objectPath.split('/').some((p) => !p || p === '.' || p === '..' || p.includes('\0'))) {
    throw new HttpError(400, 'invalid_path', 'Invalid storage path.');
  }
  const value = path.resolve(root, bucket, ...objectPath.split('/'));
  if (!value.startsWith(path.resolve(root, bucket) + path.sep)) throw new HttpError(400, 'invalid_path', 'Invalid storage path.');
  return value;
}

export interface DriveFile {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  mime_type: string | null;
  current_version_id: string | null;
  version_id: string;
  storage_bucket: string;
  storage_path: string;
  size_bytes: number;
}

/** The item and its current version, if the person can open it. */
export async function fileForUser(user: AuthUser, itemId: string): Promise<DriveFile | null> {
  return asAuthenticated(user, async (client) => {
    const result = await client.query(
      `SELECT i.id, i.workspace_id, i.parent_id, i.name, i.kind, coalesce(v.mime_type, i.mime_type) AS mime_type,
              i.current_version_id, v.id AS version_id, v.storage_bucket, v.storage_path, coalesce(v.size_bytes, i.size_bytes) AS size_bytes
         FROM public.drive_items i
         JOIN public.drive_versions v ON v.id = i.current_version_id AND v.status = 'ready'
        WHERE i.id = $1::uuid AND i.kind = 'file' AND i.trashed_at IS NULL`,
      [itemId],
    );
    return result.rows[0] ?? null;
  });
}

/** The person's role on an item ('owner' | 'editor' | 'commenter' | 'viewer' | null). */
export async function roleForUser(user: AuthUser, itemId: string): Promise<string | null> {
  return asAuthenticated(user, async (client) => {
    const result = await client.query('SELECT public.drive_get_access($1::uuid) AS access', [itemId]);
    return (result.rows[0]?.access?.my_role as string | undefined) ?? null;
  });
}

export async function readStoredFile(bucket: string, objectPath: string): Promise<Buffer> {
  return readFile(diskPath(bucket, objectPath));
}

export async function createFolder(user: AuthUser, workspaceId: string, parentId: string | null, name: string): Promise<string> {
  return asAuthenticated(user, async (client) => {
    const result = await client.query('SELECT (public.drive_create_folder($1::uuid, $2::uuid, $3)).id AS id', [workspaceId, parentId, name]);
    return result.rows[0].id as string;
  });
}

/**
 * Saves bytes as a new file, or as a new version of an existing file when
 * itemId is given (office editor saves).
 */
export async function saveFile(
  user: AuthUser,
  opts: { workspaceId: string; parentId: string | null; name: string; mimeType: string; data: Buffer; itemId?: string },
): Promise<{ item_id: string; version_id: string }> {
  if (opts.data.length > MAX_FILE_BYTES) throw new HttpError(413, 'too_large', `${opts.name} is larger than the upload limit.`);
  const ticket = await asAuthenticated(user, async (client) => {
    const result = await client.query('SELECT public.drive_begin_upload($1::uuid, $2::uuid, $3, $4, $5, $6::uuid) AS t', [
      opts.workspaceId, opts.parentId, opts.name, opts.mimeType, opts.data.length, opts.itemId ?? null,
    ]);
    return result.rows[0].t as { item_id: string; version_id: string; bucket: string; path: string };
  });
  const destination = diskPath(ticket.bucket, ticket.path);
  const temporary = `${destination}.${randomUUID()}.upload`;
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(temporary, opts.data, { flag: 'wx', mode: 0o600 });
    const metadata = JSON.stringify({
      size: opts.data.length,
      mimetype: opts.mimeType,
      checksum_sha256: createHash('sha256').update(opts.data).digest('hex'),
      upload_id: randomUUID(),
    });
    await asAuthenticated(user, async (client) => {
      await client.query(
        `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, version)
         VALUES ($1::text, $2::text, $3::uuid, $4::text, $5::jsonb, $6::text)`,
        [ticket.bucket, ticket.path, user.id, user.id, metadata, randomUUID()],
      );
      await rename(temporary, destination);
      await client.query('SELECT public.drive_finalize_upload($1::uuid)', [ticket.version_id]);
    });
    return { item_id: ticket.item_id, version_id: ticket.version_id };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    await asAuthenticated(user, (client) => client.query('SELECT public.drive_cancel_upload($1::uuid)', [ticket.version_id])).catch(() => undefined);
    throw error;
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  ai: 'application/postscript',
  eps: 'application/postscript',
  psd: 'image/vnd.adobe.photoshop',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function mimeFor(name: string): string {
  return MIME_BY_EXTENSION[extensionOf(name)] ?? 'application/octet-stream';
}
