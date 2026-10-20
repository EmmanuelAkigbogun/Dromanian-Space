import { opendir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { databasePool } from './database.js';

const storageRoot = path.resolve(process.env.STORAGE_ROOT?.trim() ?? '/data/storage');
const STALE_MS = 60 * 60 * 1000;

async function *filesBelow(directory: string): AsyncGenerator<string> {
  let entries;
  try { entries = await opendir(directory); } catch (error: any) { if (error?.code === 'ENOENT') return; throw error; }
  for await (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* filesBelow(file);
    else if (entry.isFile()) yield file;
  }
}

/**
 * Cleans interrupted staging artifacts and reports missing/orphaned permanent
 * files. Permanent data is never deleted automatically: operators can inspect
 * the report or restore from backup before resolving an inconsistency.
 */
export async function reconcileStorage(): Promise<{ stagedRemoved: number; backupsRestored: number; missing: number; orphaned: number }> {
  const now = Date.now();
  let stagedRemoved = 0;
  let backupsRestored = 0;
  const permanent = new Set<string>();
  const objects = await databasePool().query<{ bucket_id: string; name: string }>('SELECT bucket_id, name FROM storage.objects');
  const expected = new Set(objects.rows.map((object) => `${object.bucket_id}/${object.name}`));

  for await (const file of filesBelow(storageRoot)) {
    const relative = path.relative(storageRoot, file).split(path.sep).join('/');
    // Encrypted server configuration shares the durable storage mount but is
    // not a user object and must never be treated as an orphaned upload.
    if (relative.startsWith('.config/')) continue;
    const upload = /\.[0-9a-f-]{36}\.upload$/i.exec(file);
    const backup = /\.[0-9a-f-]{36}\.backup$/i.exec(file);
    if (upload || backup) {
      const info = await stat(file);
      if (now - info.mtimeMs < STALE_MS) continue;
      if (upload) {
        await rm(file, { force: true });
        stagedRemoved++;
      } else {
        const destination = file.replace(/\.[0-9a-f-]{36}\.backup$/i, '');
        const destinationRelative = path.relative(storageRoot, destination).split(path.sep).join('/');
        try {
          await stat(destination);
          await rm(file, { force: true });
          stagedRemoved++;
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
          if (expected.has(destinationRelative)) {
            await rename(file, destination);
            backupsRestored++;
          } else {
            await rm(file, { force: true });
            stagedRemoved++;
          }
        }
      }
      continue;
    }
    permanent.add(relative);
  }

  let missing = 0;
  for (const object of objects.rows) {
    const relative = `${object.bucket_id}/${object.name}`;
    if (!permanent.delete(relative)) missing++;
  }
  return { stagedRemoved, backupsRestored, missing, orphaned: permanent.size };
}
