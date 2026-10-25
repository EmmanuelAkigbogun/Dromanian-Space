// ONLYOFFICE editing for Drive files.
//   GET  /api/office/status    whether editing is set up on this server
//   POST /api/office/config    signed editor config for a file the person can open
//   GET  /api/office/file      the file, for the Document Server (signed link)
//   POST /api/office/callback  the Document Server saves edits as a new version
import { z } from 'zod';
import { authenticate, databasePool, type AuthUser } from '../server/database.js';
import { extensionOf, fileForUser, mimeFor, readStoredFile, roleForUser, saveFile } from '../server/drive-files.js';
import { errorResponse, HttpError, json, readJson } from '../server/http.js';
import { log } from '../server/log.js';
import { linkToken, officeSettings, officeType, readLinkToken, requireOffice, signJwt, verifyJwt } from '../server/office.js';

export async function status(request: Request): Promise<Response> {
  try {
    await authenticate(request);
    return json({ enabled: Boolean(officeSettings()), editor_url: '/office/web-apps/apps/api/documents/api.js' });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function config(request: Request): Promise<Response> {
  try {
    const settings = requireOffice();
    const user = await authenticate(request);
    const { item_id } = await readJson(request, z.object({ item_id: z.string().uuid() }));
    const file = await fileForUser(user, item_id);
    if (!file) throw new HttpError(404, 'not_found', 'File not found.');
    const extension = extensionOf(file.name);
    const type = officeType(extension);
    if (!type) throw new HttpError(400, 'unsupported', 'This file type cannot be opened in the editor.');
    const role = await roleForUser(user, item_id);
    const canEdit = type.editable && (role === 'owner' || role === 'editor');
    const profile = (await databasePool().query('SELECT display_name, username FROM public.profiles WHERE id = $1::uuid', [user.id])).rows[0];
    const claims = { item: file.id, version: file.version_id, user: user.id };
    const editorConfig = {
      document: {
        fileType: extension,
        // A new version gets a new key, so every save starts a fresh editing session.
        key: file.version_id,
        title: file.name,
        url: `${settings.appUrl}/api/office/file?t=${linkToken({ ...claims, purpose: 'file' }, settings.secret)}`,
        permissions: { edit: canEdit, download: true, print: true, comment: canEdit || role === 'commenter', review: canEdit },
      },
      documentType: type.type,
      editorConfig: {
        mode: canEdit ? 'edit' : 'view',
        callbackUrl: `${settings.appUrl}/api/office/callback?t=${linkToken({ ...claims, purpose: 'callback' }, settings.secret)}`,
        user: { id: user.id, name: profile?.display_name || profile?.username || 'Workspace member' },
        lang: request.headers.get('accept-language')?.slice(0, 2) || 'en',
        customization: { autosave: true, forcesave: true, compactHeader: true, uiTheme: 'theme-system' },
      },
    };
    return json({
      config: { ...editorConfig, token: signJwt(editorConfig, settings.secret) },
      editor_url: `${settings.publicPath}/web-apps/apps/api/documents/api.js`,
      can_edit: canEdit,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function file(request: Request): Promise<Response> {
  try {
    const settings = requireOffice();
    const claims = readLinkToken(new URL(request.url).searchParams.get('t'), 'file', settings.secret);
    const version = (
      await databasePool().query(
        `SELECT storage_bucket, storage_path, original_name, mime_type FROM public.drive_versions
          WHERE id = $1::uuid AND item_id = $2::uuid AND status = 'ready'`,
        [claims.version, claims.item],
      )
    ).rows[0];
    if (!version) throw new HttpError(404, 'not_found', 'File not found.');
    const data = await readStoredFile(version.storage_bucket, version.storage_path);
    return new Response(new Uint8Array(data), {
      headers: { 'content-type': version.mime_type || mimeFor(version.original_name), 'content-length': String(data.length), 'cache-control': 'no-store' },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

interface CallbackBody {
  key?: string;
  status?: number;
  url?: string;
  filetype?: string;
  users?: string[];
  token?: string;
}

export async function callback(request: Request): Promise<Response> {
  try {
    const settings = requireOffice();
    const claims = readLinkToken(new URL(request.url).searchParams.get('t'), 'callback', settings.secret);
    const raw = (await request.json()) as CallbackBody;
    // Trust only what the Document Server signed.
    const signed = raw.token ? verifyJwt<CallbackBody>(raw.token, settings.secret) : null;
    if (!signed) throw new HttpError(403, 'forbidden', 'Unsigned callback.');
    const body = signed;
    // 2: everyone closed the document; 6: forced save. Other statuses need no action.
    if ((body.status !== 2 && body.status !== 6) || !body.url) return json({ error: 0 });

    const owner = (await databasePool().query('SELECT id, email FROM auth.users WHERE id = $1::uuid AND deleted_at IS NULL', [claims.user])).rows[0];
    if (!owner) return json({ error: 1 });
    const user: AuthUser = { id: owner.id, email: owner.email };
    const current = await fileForUser(user, claims.item);
    if (!current) return json({ error: 1 });

    // The Document Server builds the download URL from its public address; fetch it privately.
    const downloadUrl = body.url.replace(/^https?:\/\/[^/]+\/office\//, `${settings.internalUrl}/`);
    const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Document download failed (${response.status})`);
    const data = Buffer.from(await response.arrayBuffer());
    await saveFile(user, {
      workspaceId: current.workspace_id,
      parentId: current.parent_id,
      name: current.name,
      mimeType: current.mime_type || mimeFor(current.name),
      data,
      itemId: current.id,
    });
    return json({ error: 0 });
  } catch (err) {
    log.warn('office callback failed', { error: err instanceof Error ? err.message : String(err) });
    if (err instanceof HttpError && err.status < 500) return errorResponse(err);
    return json({ error: 1 });
  }
}
