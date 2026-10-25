// POST /api/drive/unzip — extracts a .zip in Drive into a new folder next to
// it (named after the archive), keeping its folder structure. Runs as the
// signed-in person: they need to open the archive and edit its folder.
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { authenticate } from '../server/database.js';
import { createFolder, extensionOf, fileForUser, MAX_FILE_BYTES, mimeFor, readStoredFile, saveFile } from '../server/drive-files.js';
import { errorResponse, HttpError, json, readJson } from '../server/http.js';

const MAX_ENTRIES = 500;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const Body = z.object({ item_id: z.string().uuid() });

interface Entry {
  path: string[];
  size: number;
}

/** Skips folders, macOS metadata and anything that tries to escape the archive. */
function cleanPath(name: string): string[] | null {
  if (name.endsWith('/') || name.includes('\0')) return null;
  const parts = name.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..') || parts[0] === '__MACOSX') return null;
  const file = parts[parts.length - 1];
  if (file === '.DS_Store' || file === 'Thumbs.db' || file.startsWith('._')) return null;
  return parts;
}

export async function unzip(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const { item_id } = await readJson(request, Body);
    const archive = await fileForUser(user, item_id);
    if (!archive) throw new HttpError(404, 'not_found', 'File not found.');
    if (extensionOf(archive.name) !== 'zip' && archive.mime_type !== 'application/zip' && archive.mime_type !== 'application/x-zip-compressed') {
      throw new HttpError(400, 'not_zip', 'Only .zip archives can be extracted.');
    }
    const data = new Uint8Array(await readStoredFile(archive.storage_bucket, archive.storage_path));

    // First pass: read the directory only, so oversized archives are refused before extracting anything.
    const entries: Entry[] = [];
    let total = 0;
    let skipped = 0;
    try {
      unzipSync(data, {
        filter: (file) => {
          const parts = cleanPath(file.name);
          if (!parts) return false;
          if (file.originalSize > MAX_FILE_BYTES) {
            skipped++;
            return false;
          }
          entries.push({ path: parts, size: file.originalSize });
          total += file.originalSize;
          return false;
        },
      });
    } catch {
      throw new HttpError(400, 'invalid_zip', 'This archive is damaged or uses an unsupported format.');
    }
    if (!entries.length) throw new HttpError(400, 'empty_zip', 'The archive has no files to extract.');
    if (entries.length > MAX_ENTRIES) throw new HttpError(413, 'too_many_files', `Archives can have at most ${MAX_ENTRIES} files.`);
    if (total > MAX_TOTAL_BYTES) throw new HttpError(413, 'too_large', 'The extracted files would be larger than 1 GB.');

    const baseName = archive.name.replace(/\.zip$/i, '') || 'Extracted files';
    const rootId = await createFolder(user, archive.workspace_id, archive.parent_id, baseName);
    const folders = new Map<string, string>([['', rootId]]);
    const folderFor = async (parts: string[]): Promise<string> => {
      let key = '';
      let parent = rootId;
      for (const part of parts) {
        key = key ? `${key}/${part}` : part;
        let id = folders.get(key);
        if (!id) {
          id = await createFolder(user, archive.workspace_id, parent, part);
          folders.set(key, id);
        }
        parent = id;
      }
      return parent;
    };

    // A single top-level folder inside the archive would only add a level.
    const firstParts = new Set(entries.map((e) => (e.path.length > 1 ? e.path[0] : '')));
    const strip = firstParts.size === 1 && !firstParts.has('') ? 1 : 0;

    let created = 0;
    for (const entry of entries) {
      const fullName = entry.path.join('/');
      // Second pass, one file at a time: memory stays bounded by the per-file limit.
      const extracted = unzipSync(data, { filter: (file) => cleanPath(file.name)?.join('/') === fullName });
      const bytes = Object.values(extracted)[0];
      if (!bytes) {
        skipped++;
        continue;
      }
      const parts = entry.path.slice(strip);
      const name = parts[parts.length - 1];
      const parentId = await folderFor(parts.slice(0, -1));
      await saveFile(user, { workspaceId: archive.workspace_id, parentId, name, mimeType: mimeFor(name), data: Buffer.from(bytes) });
      created++;
    }
    return json({ folder_id: rootId, files: created, folders: folders.size - 1, skipped });
  } catch (err) {
    return errorResponse(err);
  }
}
