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

  const db = supabase as any;

  if (files && files.length > 0) {
    for (const file of files) {
      const path = await uploadFile(file, id, (p) => onFileProgress?.(file, p));
      if (!path) continue;
      await db.from('scheduled_message_attachments').insert({
        scheduled_message_id: id,
        user_id: userId,
        file_name: file.name,
        file_size: file.size,
        file_type: file.type,
        file_url: path,
      });
    }
  }

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      if (!att.file_url) continue;
      await db.from('scheduled_message_attachments').insert({
        scheduled_message_id: id,
        user_id: userId,
        file_name: att.file_name || 'file',
        file_size: Number(att.file_size) || 0,
        file_type: att.file_type || '',
        file_url: att.file_url,
      });
    }
  }

  return data as unknown as ScheduledMessage;
}
