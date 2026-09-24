import { supabase } from '@/lib/supabase';
import type { FileAttachment } from '@/types';
import type { ForwardedAttachmentPolicy } from '@/types/profile';

const BUCKET_NAME = 'message-attachments';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
// Files attached to automation actions are uploaded under this folder. They
// belong to the automation rule (not to any message), so they must survive
// message deletes/forwards and only be removed when the rule is deleted.
const AUTOMATION_STORAGE_PREFIX = 'automation/';

// Links embedded as attachments are stored as file_attachments rows with this
// MIME type. The external URL lives in file_url (no storage upload happens).
export const LINK_ATTACHMENT_TYPE = 'application/x-link';

export function isLinkFile(fileType: string): boolean {
  return fileType === LINK_ATTACHMENT_TYPE;
}

export async function getLinkAttachmentUrls(messageId: string): Promise<string[]> {
  const { data } = await supabase
    .from('file_attachments')
    .select('file_url')
    .eq('message_id', messageId)
    .eq('file_type', LINK_ATTACHMENT_TYPE);

  return (data ?? []).map((r) => r.file_url).filter((u): u is string => typeof u === 'string');
}

export async function deleteLinkAttachments(messageId: string): Promise<void> {
  await supabase
    .from('file_attachments')
    .delete()
    .eq('message_id', messageId)
    .eq('file_type', LINK_ATTACHMENT_TYPE);
}

function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isAutomationStoragePath(path: string): boolean {
  return path.startsWith(AUTOMATION_STORAGE_PREFIX);
}

export function isFileSizeValid(file: File): boolean {
  return file.size <= MAX_FILE_SIZE;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function getFileIcon(fileType: string): string {
  if (fileType === LINK_ATTACHMENT_TYPE) return 'link';
  if (fileType.startsWith('image/')) return 'image';
  if (fileType.startsWith('video/')) return 'video';
  if (fileType.startsWith('audio/')) return 'audio';
  if (fileType === 'application/pdf') return 'pdf';
  if (fileType.includes('spreadsheet') || fileType.includes('excel')) return 'spreadsheet';
  if (fileType.includes('document') || fileType.includes('word')) return 'document';
  if (fileType.includes('presentation')) return 'presentation';
  return 'file';
}

export function isImageFile(fileType: string): boolean {
  return fileType.startsWith('image/');
}

export function isVideoFile(fileType: string): boolean {
  return fileType.startsWith('video/');
}

export function isAudioFile(fileType: string): boolean {
  return fileType.startsWith('audio/');
}

export function isTextFile(fileType: string): boolean {
  return (
    fileType.startsWith('text/') ||
    fileType === 'application/json' ||
    fileType === 'application/xml' ||
    fileType === 'application/javascript' ||
    fileType === 'application/typescript'
  );
}

export function isSvgFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.svg');
}

// Browsers can report an empty or generic MIME type for .svg files (drag &
// drop, some OS/browser combos). A blob/signed URL with type
// application/octet-stream is NOT rendered by browsers inside an <img>, which
// is why SVGs show blank on initial upload and after sending. Re-wrap the file
// so every step (preview + storage metadata) uses image/svg+xml.
export function normalizeFileType(file: File): File {
  if (isSvgFile(file.name) && file.type !== 'image/svg+xml') {
    return new File([file], file.name, { type: 'image/svg+xml' });
  }
  return file;
}

export function isPdfFile(fileType: string): boolean {
  return fileType === 'application/pdf';
}

function uploadWithProgress(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (percent: number) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('cacheControl', '3600');
    form.append('', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    Object.entries(headers).forEach(([key, value]) => {
      if (value) xhr.setRequestHeader(key, value);
    });
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      }
    };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.onabort = () => resolve(false);
    xhr.send(form);
  });
}

export async function uploadFile(
  file: File,
  channelId: string,
  onProgress?: (percent: number) => void,
): Promise<string | null> {
  const ext = file.name.split('.').pop();
  const path = `${channelId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const uploadTarget = normalizeFileType(file);

  if (onProgress && typeof XMLHttpRequest !== 'undefined') {
    try {
      const sc = supabase as unknown as { supabaseUrl: string; supabaseKey: string };
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? sc.supabaseKey;
      const headers: Record<string, string> = {
        apikey: sc.supabaseKey,
        Authorization: `Bearer ${token}`,
      };
      const url = `${sc.supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${path}`;
      const ok = await uploadWithProgress(url, headers, uploadTarget, onProgress);
      return ok ? path : null;
    } catch {
      return null;
    }
  }

  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(path, uploadTarget, {
      contentType: uploadTarget.type,
      upsert: false,
    });

  if (error) return null;
  return path;
}

export function isLocalUrl(url: string): boolean {
  return url.startsWith('data:') || url.startsWith('blob:');
}

const SIGNED_URL_TTL_MS = 50 * 60 * 1000;
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

function cacheSignedUrl(fileUrl: string, signedUrl: string): void {
  signedUrlCache.set(fileUrl, { url: signedUrl, expiresAt: Date.now() + SIGNED_URL_TTL_MS });
}

function getCachedSignedUrl(fileUrl: string): string | null {
  const hit = signedUrlCache.get(fileUrl);
  if (hit && hit.expiresAt > Date.now()) return hit.url;
  if (hit) signedUrlCache.delete(fileUrl);
  return null;
}

export async function getSignedUrl(fileUrl: string): Promise<string | null> {
  if (isLocalUrl(fileUrl)) return fileUrl;
  const cached = getCachedSignedUrl(fileUrl);
  if (cached) return cached;
  const path = fileUrl.replace(`${BUCKET_NAME}/`, '');
  const { data } = await supabase.storage.from(BUCKET_NAME).createSignedUrl(path, 3600);
  if (data?.signedUrl) {
    cacheSignedUrl(fileUrl, data.signedUrl);
    return data.signedUrl;
  }
  return null;
}

export async function getSignedUrlsBatch(fileUrls: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const uniqueUrls = [...new Set(fileUrls)];
  uniqueUrls.forEach((url) => {
    if (isLocalUrl(url)) result.set(url, url);
  });

  const remote = uniqueUrls.filter((url) => !isLocalUrl(url));
  const uncached: string[] = [];
  for (const url of remote) {
    const hit = getCachedSignedUrl(url);
    if (hit) {
      result.set(url, hit);
    } else {
      uncached.push(url);
    }
  }
  if (uncached.length === 0) return result;

  const paths = uncached.map((url) => url.replace(`${BUCKET_NAME}/`, ''));

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: batch } = await supabase.storage.from(BUCKET_NAME).createSignedUrls(paths, 3600);

    // A batch response is definitive: rows carry signedUrl or null for every
    // path, including files that no longer exist. Treating it as final avoids
    // the per-path fallback that fires 400s for missing forwarded files.
    if (batch && batch.length > 0) {
      const byPath = new Map<string, string | null>();
      batch.forEach((row) => {
        if (row.path) byPath.set(row.path, row.signedUrl ?? null);
      });
      uncached.forEach((url) => {
        const signed = byPath.get(url.replace(`${BUCKET_NAME}/`, '')) ?? null;
        result.set(url, signed);
        if (signed) cacheSignedUrl(url, signed);
      });
      return result;
    }

    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  // The batch RPC failed entirely; fall back to individual lookups, silently.
  const settled = await Promise.all(
    paths.map(async (path) => {
      try {
        const { data: signed } = await supabase.storage.from(BUCKET_NAME).createSignedUrl(path, 3600);
        return { path, url: signed?.signedUrl ?? null };
      } catch {
        return { path, url: null };
      }
    }),
  );
  const byPath = new Map(settled.map((s) => [s.path, s.url]));
  uncached.forEach((url) => {
    const signed = byPath.get(url.replace(`${BUCKET_NAME}/`, '')) ?? null;
    result.set(url, signed);
    if (signed) cacheSignedUrl(url, signed);
  });
  return result;
}

export async function createFileAttachment(
  messageId: string,
  userId: string,
  file: File,
  fileUrl: string,
): Promise<FileAttachment | null> {
  const { data, error } = await supabase
    .from('file_attachments')
    .insert({
      message_id: messageId,
      user_id: userId,
      file_name: file.name,
      file_size: file.size,
      file_type: file.type,
      file_url: fileUrl,
    })
    .select()
    .single();

  if (error || !data) return null;
  return data as FileAttachment;
}

export async function createLinkAttachment(
  messageId: string,
  userId: string,
  url: string,
): Promise<FileAttachment | null> {
  const { data, error } = await supabase
    .from('file_attachments')
    .insert({
      message_id: messageId,
      user_id: userId,
      file_name: url,
      file_size: 0,
      file_type: LINK_ATTACHMENT_TYPE,
      file_url: url,
    })
    .select()
    .single();

  if (error || !data) return null;
  return data as FileAttachment;
}

let sortOrderSupported: boolean | null = null;

async function supportsSortOrder(): Promise<boolean> {
  if (sortOrderSupported !== null) return sortOrderSupported;
  const { error } = await supabase.from('file_attachments').select('id, sort_order').limit(1);
  sortOrderSupported = !error;
  return sortOrderSupported;
}

export async function getMessageAttachments(
  messageId: string,
): Promise<FileAttachment[]> {
  const orderCol = (await supportsSortOrder()) ? 'sort_order' : 'created_at';
  const { data, error } = await supabase
    .from('file_attachments')
    .select('*')
    .eq('message_id', messageId)
    .order(orderCol, { ascending: true });

  if (error || !data) return [];
  return data as FileAttachment[];
}

export async function getAttachmentsByMessageIds(
  messageIds: string[],
): Promise<Map<string, FileAttachment[]>> {
  if (messageIds.length === 0) return new Map();

  const orderCol = (await supportsSortOrder()) ? 'sort_order' : 'created_at';
  const { data, error } = await supabase
    .from('file_attachments')
    .select('*')
    .in('message_id', messageIds)
    .order(orderCol, { ascending: true });

  if (error || !data) return new Map();

  const grouped = new Map<string, FileAttachment[]>();
  messageIds.forEach((id) => grouped.set(id, []));
  (data as FileAttachment[]).forEach((attachment) => {
    const existing = grouped.get(attachment.message_id) ?? [];
    existing.push(attachment);
    grouped.set(attachment.message_id, existing);
  });

  return grouped;
}

export async function copyAttachmentsForForward(
  sourceMessageId: string,
  targetMessageId: string,
  userId: string,
): Promise<void> {
  const sourceAttachments = await getMessageAttachments(sourceMessageId);
  if (sourceAttachments.length === 0) return;

  const rows = sourceAttachments.map((a) => ({
    message_id: targetMessageId,
    user_id: userId,
    file_name: a.file_name,
    file_size: a.file_size,
    file_type: a.file_type,
    file_url: a.file_url,
    sort_order: a.sort_order ?? 0,
  }));

  await supabase.from('file_attachments').insert(rows);
}

export async function reorderAttachments(orderedIds: string[]): Promise<boolean> {
  if (orderedIds.length === 0) return true;
  if (!(await supportsSortOrder())) return false;
  const updates = orderedIds.map((id, index) =>
    supabase.from('file_attachments').update({ sort_order: index }).eq('id', id),
  );
  const results = await Promise.all(updates);
  return results.every((r) => !r.error);
}

export async function removeAttachmentFromStorage(fileUrl: string): Promise<void> {
  if (!fileUrl.includes(`${BUCKET_NAME}/`)) return;
  const path = fileUrl.replace(`${BUCKET_NAME}/`, '');
  await supabase.storage.from(BUCKET_NAME).remove([path]);
}

// Remove the storage objects behind automation attachment file_urls. Called
// only when the owning automation rule is deleted; automation files are never
// removed by message deletes or forwards.
export async function deleteAutomationAttachmentFiles(fileUrls: string[]): Promise<void> {
  const paths = [...new Set(fileUrls)]
    .filter((url) => !isLocalUrl(url))
    .map((url) => url.replace(`${BUCKET_NAME}/`, ''))
    .filter((path) => isAutomationStoragePath(path));
  if (paths.length === 0) return;
  await supabase.storage.from(BUCKET_NAME).remove(paths);
}

export async function removeStoragePath(path: string): Promise<void> {
  if (!path) return;
  await supabase.storage.from(BUCKET_NAME).remove([path]);
}

export async function deleteFileAttachment(
  attachmentId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('file_attachments')
    .select('file_url')
    .eq('id', attachmentId)
    .single();

  const { error } = await supabase
    .from('file_attachments')
    .delete()
    .eq('id', attachmentId);

  if (!error && data?.file_url) {
    await removeAttachmentFromStorage(data.file_url);
  }

  return !error;
}

export type { ForwardedAttachmentPolicy };

export async function getCurrentForwardedAttachmentPolicy(userId?: string): Promise<ForwardedAttachmentPolicy> {
  // Avoid supabase.auth.getUser() here: it is a network call that validates and
  // can refresh the access token, and deleteMessage() runs it once per message.
  // A bulk delete fires dozens of these concurrently, which races the token
  // auto-refresh (near the 1h expiry) and can force a SIGNED_OUT event. Callers
  // already know the user id, so read the profile preference directly instead.
  let resolvedUserId = userId;
  if (!resolvedUserId) {
    const { data: userData } = await supabase.auth.getSession();
    resolvedUserId = userData.session?.user?.id;
  }
  if (!resolvedUserId) return 'keep';
  const { data } = await supabase
    .from('profiles')
    .select('forwarded_attachment_policy')
    .eq('id', resolvedUserId)
    .maybeSingle();
  const value = (data as { forwarded_attachment_policy?: string } | null)?.forwarded_attachment_policy;
  return value === 'delete' ? 'delete' : 'keep';
}

export async function deleteAttachmentsByMessageId(
  messageId: string,
  policy: ForwardedAttachmentPolicy = 'keep',
): Promise<string[]> {
  const { data } = await supabase
    .from('file_attachments')
    .select('file_url')
    .eq('message_id', messageId);

  if (!data || data.length === 0) return [messageId];

  const fileUrls = [...new Set(data.map((a) => a.file_url))];

  const affected = new Set<string>([messageId]);
  await supabase.from('file_attachments').delete().eq('message_id', messageId);

  if (policy === 'delete') {
    // Fully delete the storage files, but leave the forwarded copies'
    // attachment rows in place so they still render the empty file grids
    // (one per attachment) until the user actually deletes those copies.
    const { data: forwarded } = await supabase
      .from('file_attachments')
      .select('message_id')
      .in('file_url', fileUrls);
    if (forwarded && forwarded.length > 0) {
      forwarded.forEach((row) => affected.add(row.message_id));
    }
    // Never remove automation-owned files: they are still referenced by the
    // automation rule config and would break future triggers.
    const paths = fileUrls
      .map((u) => u.replace(`${BUCKET_NAME}/`, ''))
      .filter((p) => !isAutomationStoragePath(p))
      .filter((p) => !isExternalUrl(p));
    if (paths.length > 0) await supabase.storage.from(BUCKET_NAME).remove(paths);
    return [...affected];
  }

  // Keep forwarded copies working: only delete storage objects that are no
  // longer referenced by any remaining attachment (e.g. a forward of this
  // message), otherwise the forwards keep the files. Automation-owned files
  // are exempt for the same reason as above.
  const { data: referenced } = await supabase
    .from('file_attachments')
    .select('file_url')
    .in('file_url', fileUrls);

  const stillReferenced = new Set((referenced ?? []).map((a) => a.file_url));
  const paths = fileUrls
    .filter((u) => !stillReferenced.has(u))
    .map((u) => u.replace(`${BUCKET_NAME}/`, ''))
    .filter((p) => !isAutomationStoragePath(p))
    .filter((p) => !isExternalUrl(p));
  if (paths.length > 0) await supabase.storage.from(BUCKET_NAME).remove(paths);
  return [...affected];
}
