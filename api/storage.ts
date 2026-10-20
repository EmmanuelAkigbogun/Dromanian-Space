import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { asAuthenticated, authenticate, databasePool } from '../server/database.js';
import { HttpError, json, readJson } from '../server/http.js';

const root = path.resolve(process.env.STORAGE_ROOT?.trim() ?? '/data/storage');
const MAX_FILE_BYTES = Number(process.env.STORAGE_MAX_FILE_BYTES ?? 50 * 1024 * 1024);
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function signingSecret(): string {
  const value = process.env.STORAGE_SIGNING_SECRET?.trim() || process.env.APP_JWT_SECRET?.trim();
  if (!value) throw new HttpError(503, 'not_configured', 'Storage signing is not configured.');
  return value;
}

export function storageSignature(bucket: string, objectPath: string, expires: number): string {
  return createHmac('sha256', signingSecret()).update(`${bucket}\n${objectPath}\n${expires}`).digest('base64url');
}

export function validStorageSignature(url: URL, bucket: string, objectPath: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const expires = Number(url.searchParams.get('expires'));
  const supplied = url.searchParams.get('signature');
  if (!Number.isSafeInteger(expires) || expires <= nowSeconds || !supplied) return false;
  const expected = Buffer.from(storageSignature(bucket, objectPath, expires));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseByteRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }
  if (![start, end].every(Number.isSafeInteger) || start < 0 || start > end || start >= size || end >= size) return null;
  return { start, end };
}

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
  const destination = diskPath(bucket, objectPath);
  const temporary = `${destination}.${randomUUID()}.upload`;
  const backup = `${destination}.${randomUUID()}.backup`;
  await mkdir(path.dirname(destination), { recursive: true });
  if (!request.body) throw new HttpError(400, 'empty_upload', 'The upload body is empty.');
  let size = 0;
  const hash = createHash('sha256');
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) {
        callback(new HttpError(413, 'too_large', 'File is larger than the configured upload limit.'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(request.body as unknown as NodeReadableStream),
      meter,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      { signal: request.signal },
    );
    const upsert = request.headers.get('x-upsert') === 'true';
    const uploadId = request.headers.get('x-upload-id')?.slice(0, 128) || randomUUID();
    const checksum = hash.digest('hex');
    const client = await databasePool().connect();
    let installed = false;
    let backedUp = false;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated' })]);
      const existing = await client.query(
        `SELECT id, name, metadata FROM storage.objects
          WHERE bucket_id = $1::text AND name = $2::text FOR UPDATE`,
        [bucket, objectPath],
      );
      const sameUpload = existing.rows[0]?.metadata?.upload_id === uploadId
        && existing.rows[0]?.metadata?.checksum_sha256 === checksum;
      if (sameUpload) {
        try {
          await stat(destination);
          await client.query('COMMIT');
          await rm(temporary, { force: true });
          return json({ id: existing.rows[0].id, name: existing.rows[0].name, path: objectPath, checksum, uploadId, idempotent: true });
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
          // The database row survived but its bytes did not. This retry is
          // allowed to reinstall the exact same finalized upload.
        }
      }
      if (existing.rowCount && !upsert && !sameUpload) throw new HttpError(409, 'already_exists', 'A file already exists at this path.');
      const metadata = JSON.stringify({
        size,
        mimetype: request.headers.get('content-type') ?? 'application/octet-stream',
        checksum_sha256: checksum,
        upload_id: uploadId,
      });
      const sql = upsert || sameUpload
        ? `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, version, updated_at)
           VALUES ($1::text, $2::text, $3::uuid, $4::text, $5::jsonb, $6::text, now())
           ON CONFLICT (bucket_id, name) DO UPDATE SET metadata = excluded.metadata, version = excluded.version,
             owner = excluded.owner, owner_id = excluded.owner_id, updated_at = now()
           RETURNING id, name`
        : `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, version)
           VALUES ($1::text, $2::text, $3::uuid, $4::text, $5::jsonb, $6::text) RETURNING id, name`;
      const result = await client.query(sql, [bucket, objectPath, user.id, user.id, metadata, randomUUID()]);
      if (existing.rowCount) {
        try { await rename(destination, backup); backedUp = true; } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      }
      await rename(temporary, destination);
      installed = true;
      await client.query('COMMIT');
      if (backedUp) await rm(backup, { force: true });
      return json({ ...result.rows[0], path: objectPath, checksum, uploadId });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (installed) await rm(destination, { force: true }).catch(() => undefined);
      if (backedUp) await rename(backup, destination).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
  const client = await databasePool().connect();
  const staged: Array<{ source: string; backup: string }> = [];
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE authenticated');
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated' })]);
    const result = await client.query(
      'DELETE FROM storage.objects WHERE bucket_id = $1::text AND name = ANY($2::text[]) RETURNING id, name',
      [bucket, paths],
    );
    for (const row of result.rows) {
      const source = diskPath(bucket, row.name);
      const backup = `${source}.${randomUUID()}.backup`;
      try {
        await rename(source, backup);
        staged.push({ source, backup });
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await client.query('COMMIT');
    await Promise.all(staged.map(({ backup }) => rm(backup, { force: true })));
    return json(result.rows);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await Promise.all(staged.map(({ source, backup }) => rename(backup, source).catch(() => undefined)));
    throw error;
  } finally {
    client.release();
  }
}

export async function sign(request: Request, bucketValue: string): Promise<Response> {
  const user = await authenticate(request);
  const bucket = decodeURIComponent(bucketValue);
  if (!safeName.test(bucket)) throw new HttpError(400, 'invalid_path', 'Invalid bucket.');
  const { paths, expiresIn } = await readJson(request, z.object({ paths: z.array(z.string().min(1).max(1000)).max(1000), expiresIn: z.number().positive().max(604800) }));
  const allowed = await asAuthenticated(user, async (client) => {
    const result = await client.query('SELECT name FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2::text[])', [bucket, paths]);
    return new Set(result.rows.map((row) => row.name));
  });
  const expires = Math.floor(Date.now() / 1000) + Math.floor(expiresIn);
  return json(paths.map((objectPath) => allowed.has(objectPath)
    ? { path: objectPath, signedUrl: `/api/storage/file/${encodeURIComponent(bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}?expires=${expires}&signature=${encodeURIComponent(storageSignature(bucket, objectPath, expires))}` }
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
    if (validStorageSignature(new URL(request.url), bucket, objectPath)) {
      object = (await databasePool().query('SELECT metadata FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, objectPath])).rows[0];
    } else {
      const user = await authenticate(request);
      object = await asAuthenticated(user, async (client) => (await client.query('SELECT metadata FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, objectPath])).rows[0]);
    }
  }
  if (!object) throw new HttpError(404, 'not_found', 'File not found.');
  const target = diskPath(bucket, objectPath);
  let fileStat;
  try { fileStat = await stat(target); } catch (error: any) { if (error?.code === 'ENOENT') throw new HttpError(404, 'not_found', 'File not found.'); throw error; }
  const range = request.headers.get('range');
  let start = 0;
  let end = Math.max(0, fileStat.size - 1);
  let status = 200;
  if (range) {
    const parsed = parseByteRange(range, fileStat.size);
    if (!parsed) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${fileStat.size}` } });
    ({ start, end } = parsed);
    status = 206;
  }
  const responseHeaders = {
    'content-type': object.metadata?.mimetype ?? 'application/octet-stream',
    'content-length': String(fileStat.size === 0 ? 0 : end - start + 1),
    'accept-ranges': 'bytes',
    ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${fileStat.size}` } : {}),
    'cache-control': bucketRow.rows[0].public ? 'public, max-age=3600' : 'private, no-store',
    'content-disposition': `inline; filename="${path.basename(objectPath).replaceAll('"', '')}"`,
    'etag': object.metadata?.checksum_sha256 ? `"sha256-${object.metadata.checksum_sha256}"` : `W/"${fileStat.size}-${Math.floor(fileStat.mtimeMs)}"`,
  };
  if (request.method === 'HEAD' || fileStat.size === 0) return new Response(null, { status, headers: responseHeaders });
  const stream = Readable.toWeb(createReadStream(target, { start, end })) as unknown as ReadableStream;
  return new Response(stream, { status, headers: responseHeaders });
}

