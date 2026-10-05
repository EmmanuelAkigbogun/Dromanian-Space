import { supabase } from '@/lib/supabase';
import { uploadFile } from '@/lib/message/attachment';
import { generateId } from '@/utils';
import type { LinkDisplayMode, ScheduledMessage } from '@/types';

export interface ScheduleAttachmentMeta {
  file_url: string;
  file_name: string;
  file_size: number;
  file_type: string;
}

export interface ScheduleMessageInput {
  content: string;
  scheduledAt: string;
  channelId?: string | null;
  conversationId?: string | null;
  parentId?: string | null;
  linkMode?: LinkDisplayMode | null;
  files?: File[];
  // Pre-uploaded attachment metadata (used by automations, which upload files
  // at rule-save time and only persist the storage path in the config).
  attachments?: ScheduleAttachmentMeta[];
  userId: string;
  onFileProgress?: (file: File, percent: number) => void;
}

export async function createScheduledMessage(input: ScheduleMessageInput): Promise<ScheduledMessage | null> {
  const id = generateId();
  const { content, scheduledAt, channelId, conversationId, parentId, linkMode, files, attachments, userId, onFileProgress } = input;
  const hasAttachments = (files?.length ?? 0) > 0 || (attachments?.length ?? 0) > 0;

  // With attachments the row starts as a draft: the server does not deliver it
  // until queue_scheduled_message() runs after every upload has finished.
  const payload = {
    id,
    user_id: userId,
    channel_id: channelId || null,
    conversation_id: conversationId || null,
    parent_id: parentId || null,
    content,
    link_mode: linkMode ?? null,
    scheduled_at: new Date(scheduledAt).toISOString(),
    sent: false,
    status: hasAttachments ? 'draft' : 'pending',
    created_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('scheduled_messages' as never)
    .insert(payload as never)
    .select()
    .single();

  if (error || !data) {
    console.error('Failed to schedule message:', error);
    return null;
  }

  const ok = await attachScheduledFiles(id, userId, files, attachments, onFileProgress);
  if (!hasAttachments) return data as unknown as ScheduledMessage;
  if (!ok) {
    // Leave it as a draft so the sender can see the upload did not finish.
    return { ...(data as unknown as ScheduledMessage), status: 'draft' };
  }
  const { error: queueError } = await supabase.rpc('queue_scheduled_message' as never, { p_id: id } as never);
  if (queueError) return { ...(data as unknown as ScheduledMessage), status: 'draft' };
  return { ...(data as unknown as ScheduledMessage), status: 'pending' };
}

/** Uploads new files and records pre-uploaded ones. Returns false if any failed. */
export async function attachScheduledFiles(
  scheduledMessageId: string,
  userId: string,
  files?: File[],
  attachments?: ScheduleAttachmentMeta[],
  onFileProgress?: (file: File, percent: number) => void,
): Promise<boolean> {
  const db = supabase as any;
  let ok = true;

  for (const file of files ?? []) {
    const path = await uploadFile(file, scheduledMessageId, (p) => onFileProgress?.(file, p));
    if (!path) {
      ok = false;
      continue;
    }
    const { error } = await db.from('scheduled_message_attachments').insert({
      scheduled_message_id: scheduledMessageId,
      user_id: userId,
      file_name: file.name,
      file_size: file.size,
      file_type: file.type,
      file_url: path,
    });
    if (error) ok = false;
  }

  for (const att of attachments ?? []) {
    if (!att.file_url) continue;
    const { error } = await db.from('scheduled_message_attachments').insert({
      scheduled_message_id: scheduledMessageId,
      user_id: userId,
      file_name: att.file_name || 'file',
      file_size: Number(att.file_size) || 0,
      file_type: att.file_type || '',
      file_url: att.file_url,
    });
    if (error) ok = false;
  }

  return ok;
}
