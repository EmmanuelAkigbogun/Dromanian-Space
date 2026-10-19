import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { asAuthenticated, authenticate, databasePool } from '../server/database.js';
import { HttpError, json, readJson } from '../server/http.js';

const root = path.resolve(process.env.STORAGE_ROOT?.trim() ?? '/data/storage');
const MAX_FILE_BYTES = Number(process.env.STORAGE_MAX_FILE_BYTES ?? 50 * 1024 * 1024);
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function parts(suffix: string): { bucket: string; objectPath: string } {
  const [rawBucket, ...rawParts] = suffix.split('/');
  const bucket = decodeURIComponent(rawBucket ?? '');
  const objectPath = rawParts.map(decodeURIComponent).join('/');
  if (!safeName.test(bucket) || !objectPath || objectPath.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new HttpError(400, 'invalid_path', 'Invalid storage path.');
  }
  return { bucket, objectPath };
}

function diskPath(bucket: string, objectPath: string): string {
  const value = path.resolve(root, bucket, ...objectPath.split('/'));
  const base = path.resolve(root, bucket) + path.sep;
  if (!value.startsWith(base)) throw new HttpError(400, 'invalid_path', 'Invalid storage path.');
  return value;
}

export async function upload(request: Request, suffix: string): Promise<Response> {
  const user = await authenticate(request);
  const { bucket, objectPath } = parts(suffix);
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_FILE_BYTES) throw new HttpError(413, 'too_large', 'File is larger than the configured upload limit.');
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) throw new HttpError(413, 'too_large', 'File is larger than the configured upload limit.');
  const destination = diskPath(bucket, objectPath);
  const temporary = `${destination}.${randomUUID()}.upload`;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(temporary, bytes, { flag: 'wx' });
  try {
    const upsert = request.headers.get('x-upsert') === 'true';
    const row = await asAuthenticated(user, async (client) => {
      const metadata = JSON.stringify({ size: bytes.byteLength, mimetype: request.headers.get('content-type') ?? 'application/octet-stream' });
      const sql = upsert
        ? `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, version, updated_at)
           VALUES ($1, $2, $3, $3::text, $4::jsonb, $5, now())
           ON CONFLICT (bucket_id, name) DO UPDATE SET metadata = excluded.metadata, version = excluded.version, updated_at = now()
           RETURNING id, name`
        : `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, version)
           VALUES ($1, $2, $3, $3::text, $4::jsonb, $5) RETURNING id, name`;
      const result = await client.query(sql, [bucket, objectPath, user.id, metadata, randomUUID()]);
      return result.rows[0];
    });
    await rename(temporary, destination);
    return json({ ...row, path: objectPath });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if ((error as any)?.code === '23505') throw new HttpError(409, 'already_exists', 'A file already exists at this path.');
    throw error;
  }
}

export async function list(request: Request, bucketValue: string): Promise<Response> {
  const user = await authenticate(request);
  const bucket = decodeURIComponent(bucketValue);
  if (!safeName.test(bucket)) throw new HttpError(400, 'invalid_path', 'Invalid bucket.');
  const body = await readJson(request, z.object({
    path: z.string().max(1000).default(''), limit: z.number().int().min(1).max(1000).optional(), offset: z.number().int().min(0).optional(),
    search: z.string().max(255).optional(), sortBy: z.object({ column: z.enum(['name', 'created_at', 'updated_at']), order: z.enum(['asc', 'desc']) }).optional(),
  }));
  const prefix = body.path ? `${body.path.replace(/^\/+|\/+$/g, '')}/` : '';
  const column = body.sortBy?.column ?? 'name';
  const direction = body.sortBy?.order === 'desc' ? 'DESC' : 'ASC';
  const rows = await asAuthenticated(user, async (client) => {
    const result = await client.query(
      `SELECT id, regexp_replace(name, '^' || $2, '') AS name, metadata, created_at, updated_at
         FROM storage.objects
        WHERE bucket_id = $1 AND name LIKE $2 || '%' AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%')
        ORDER BY ${column} ${direction} LIMIT $4 OFFSET $5`,
      [bucket, prefix, body.search ?? null, body.limit ?? 100, body.offset ?? 0],
    );
    return result.rows.filter((row) => !row.name.includes('/'));
  });
  return json(rows);
}

export async function remove(request: Request, bucketValue: string): Promise<Response> {
  const user = await authenticate(request);
  const bucket = decodeURIComponent(bucketValue);
  if (!safeName.test(bucket)) throw new HttpError(400, 'invalid_path', 'Invalid bucket.');
  const { paths } = await readJson(request, z.object({ paths: z.array(z.string().min(1).max(1000)).min(1).max(1000) }));
  const removed = await asAuthenticated(user, async (client) => {
    const result = await client.query('DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2::text[]) RETURNING id, name', [bucket, paths]);
    return result.rows;
  });
  await Promise.all(removed.map((row) => unlink(diskPath(bucket, row.name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; })));
  return json(removed);
}

export async function sign(request: Request, bucketValue: string): Promise<Response> {
  const user = await authenticate(request);
  const bucket = decodeURIComponent(bucketValue);
  if (!safeName.test(bucket)) throw new HttpError(400, 'invalid_path', 'Invalid bucket.');
  const { paths } = await readJson(request, z.object({ paths: z.array(z.string().min(1).max(1000)).max(1000), expiresIn: z.number().positive().max(604800) }));
  const allowed = await asAuthenticated(user, async (client) => {
    const result = await client.query('SELECT name FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2::text[])', [bucket, paths]);
    return new Set(result.rows.map((row) => row.name));
  });
  return json(paths.map((objectPath) => allowed.has(objectPath)
    ? { path: objectPath, signedUrl: `/api/storage/file/${encodeURIComponent(bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}` }
    : { path: objectPath, signedUrl: null, error: 'Not found' }));
}

export async function file(request: Request, suffix: string): Promise<Response> {
  const { bucket, objectPath } = parts(suffix);
  const bucketRow = await databasePool().query('SELECT public FROM storage.buckets WHERE id = $1', [bucket]);
  if (!bucketRow.rowCount) throw new HttpError(404, 'not_found', 'File not found.');
  let object: any;
  if (bucketRow.rows[0].public) {
    object = (await databasePool().query('SELECT metadata FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, objectPath])).rows[0];
  } else {
    const user = await authenticate(request);
    object = await asAuthenticated(user, async (client) => (await client.query('SELECT metadata FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, objectPath])).rows[0]);
  }
  if (!object) throw new HttpError(404, 'not_found', 'File not found.');
  let bytes: Buffer;
  try { bytes = await readFile(diskPath(bucket, objectPath)); } catch (error: any) { if (error?.code === 'ENOENT') throw new HttpError(404, 'not_found', 'File not found.'); throw error; }
  return new Response(new Uint8Array(bytes), { headers: {
    'content-type': object.metadata?.mimetype ?? 'application/octet-stream',
    'content-length': String(bytes.byteLength),
    'cache-control': bucketRow.rows[0].public ? 'public, max-age=3600' : 'private, no-store',
    'content-disposition': `inline; filename="${path.basename(objectPath).replaceAll('"', '')}"`,
  } });
}

