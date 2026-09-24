import { supabase } from '@/lib/supabase';
import { isTempId } from './formatting';
import { deleteAttachmentsByMessageId, getCurrentForwardedAttachmentPolicy, type ForwardedAttachmentPolicy } from './attachment';
import { extractMentionUsernames } from './mention';
import { createTypedNotification } from '@/features/notifications/service';
import type { LinkDisplayMode, Message, PinnedMessage, SavedMessage } from '@/types';

const PAGE_SIZE = 50;

export interface MessagesPage {
  messages: Message[];
  hasMore: boolean;
}

export async function getChannelMessages(
  channelId: string,
  options?: { limit?: number; before?: string },
): Promise<MessagesPage> {
  const limit = options?.limit ?? PAGE_SIZE;
  const query = supabase
    .from('messages')
    .select('*')
    .eq('channel_id', channelId)
    .is('parent_id', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (options?.before) {
    query.lt('created_at', options.before);
  }

  const { data, error } = await query;

  if (error || !data) return { messages: [], hasMore: false };

  const messages = (data as Message[]).reverse();
  return {
    messages,
    hasMore: data.length === limit,
  };
}

export async function sendMessage(
  channelId: string,
  userId: string,
  content: string,
  options?: { parentId?: string; forwardedFromMessageId?: string; attachmentsLayout?: string | null; linkMode?: LinkDisplayMode | null },
): Promise<Message | null> {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      channel_id: channelId,
      user_id: userId,
      content: content.trim(),
      parent_id: options?.parentId ?? null,
      forwarded_from_message_id: options?.forwardedFromMessageId ?? null,
      attachments_layout: options?.attachmentsLayout ?? null,
      link_mode: options?.linkMode ?? null,
    })
    .select()
    .single();

  if (error || !data) return null;

  createMessageNotifications(channelId, userId, content, data.id, options?.parentId).catch(() => {});

  return data as Message;
}

async function createMessageNotifications(
  channelId: string,
  senderId: string,
  content: string,
  messageId: string,
  parentId?: string,
): Promise<void> {
  const [memberIds, senderProfile, channel] = await Promise.all([
    supabase.from('channel_members').select('user_id').eq('channel_id', channelId),
    supabase.from('profiles').select('display_name, username').eq('id', senderId).single(),
    supabase.from('channels').select('name, workspace_id').eq('id', channelId).single(),
  ]);

  if (memberIds.error || !memberIds.data) return;

  const recipientIds = memberIds.data
    .map((m) => m.user_id)
    .filter((id) => id !== senderId);

  if (recipientIds.length === 0) return;

  const senderName = senderProfile.data?.display_name || senderProfile.data?.username || 'Someone';
  const channelName = channel.data?.name || 'a channel';
  const workspaceId = channel.data?.workspace_id || null;
  const isThread = !!parentId;

  const mentionedUsernames = extractMentionUsernames(content);
  const mentionedLower = new Set(mentionedUsernames.map((u) => u.toLowerCase()));

  let profiles: Array<{ id: string; username: string | null; display_name: string | null }> = [];
  if (mentionedLower.size > 0) {
    const { data } = await supabase
      .from('profiles')
      .select('id, username, display_name')
      .in('id', recipientIds);
    profiles = data ?? [];
  }

  const link = `/channels/${channelId}${isThread ? `?thread=${parentId}` : ''}`;

  const notificationPromises: Promise<boolean>[] = [];

  for (const recipientId of recipientIds) {
    const profile = profiles.find((p) => p.id === recipientId);
    const username = profile?.username?.toLowerCase() ?? '';
    const displayName = profile?.display_name?.toLowerCase() ?? '';
    const isMentioned = mentionedLower.has(username) || (displayName && mentionedLower.has(displayName));

    if (isMentioned) {
      notificationPromises.push(
        createTypedNotification(
          recipientId,
          'mention',
          `${senderName} mentioned you in #${channelName}`,
          content.length > 120 ? `${content.slice(0, 120)}...` : content,
          link,
          'messaging',
          'message',
          messageId,
          senderId,
          workspaceId,
        ),
      );
    } else {
      notificationPromises.push(
        createTypedNotification(
          recipientId,
          'message',
          `New message from ${senderName} in #${channelName}`,
          content.length > 120 ? `${content.slice(0, 120)}...` : content,
          link,
          'messaging',
          'message',
          messageId,
          senderId,
          workspaceId,
        ),
      );
    }
  }

  await Promise.allSettled(notificationPromises);
}

export async function updateMessage(
  messageId: string,
  content: string,
  options?: { linkMode?: LinkDisplayMode | null },
): Promise<Message | null> {
  const { data: existing } = await supabase
    .from('messages')
    .select('user_id, content')
    .eq('id', messageId)
    .single();

  if (existing) {
    await supabase.rpc('record_message_version' as any, {
      p_message_id: messageId,
      p_user_id: existing.user_id,
      p_content: existing.content,
    });
  }

  const { data, error } = await supabase
    .from('messages')
    .update({
      content: content.trim(),
      edited_at: new Date().toISOString(),
      link_mode: options?.linkMode ?? null,
    })
    .eq('id', messageId)
    .select()
    .single();

  if (error || !data) return null;
  return data as Message;
}

export async function deleteMessage(
  messageId: string,
  options?: { userId?: string; policy?: ForwardedAttachmentPolicy },
): Promise<boolean> {
  // Fetch the policy at most once per call, never via supabase.auth.getUser()
  // (see getCurrentForwardedAttachmentPolicy). Bulk deletes should fetch it
  // once up front and pass it down to avoid a burst of parallel auth calls.
  const policy = options?.policy ?? (await getCurrentForwardedAttachmentPolicy(options?.userId));
  const affectedIds = await deleteAttachmentsByMessageId(messageId, policy);

  if (typeof window !== 'undefined') {
    affectedIds.forEach((id) => {
      window.dispatchEvent(
        new CustomEvent('attachments-updated', {
          detail: { messageId: id },
        }),
      );
    });
  }

  const { error } = await supabase
    .from('messages')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', messageId);

  return !error;
}

export async function getMessageById(messageId: string): Promise<Message | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .maybeSingle();

  if (error || !data) return null;
  return data as Message;
}

export async function getMessagesByIds(messageIds: string[]): Promise<Message[]> {
  if (messageIds.length === 0) return [];
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .in('id', messageIds);

  if (error || !data) return [];
  return data as Message[];
}

export async function getThreadMessages(
  parentId: string,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('parent_id', parentId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });

  if (error || !data) return [];
  return data as Message[];
}

export async function pinMessage(
  channelId: string,
  messageId: string,
  pinnedBy: string,
): Promise<PinnedMessage | null> {
  const { data, error } = await supabase
    .from('pinned_messages')
    .insert({
      channel_id: channelId,
      message_id: messageId,
      pinned_by: pinnedBy,
    })
    .select()
    .single();

  if (error || !data) return null;
  return data as PinnedMessage;
}

export async function unpinMessage(
  channelId: string,
  messageId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('pinned_messages')
    .delete()
    .eq('channel_id', channelId)
    .eq('message_id', messageId);

  return !error;
}

export async function isMessagePinned(
  channelId: string,
  messageId: string,
): Promise<boolean> {
  const { count } = await supabase
    .from('pinned_messages')
    .select('*', { count: 'exact', head: true })
    .eq('channel_id', channelId)
    .eq('message_id', messageId);

  return (count ?? 0) > 0;
}

export async function saveMessage(
  userId: string,
  messageId: string,
): Promise<SavedMessage | null> {
  const { data, error } = await supabase
    .from('saved_messages')
    .insert({
      user_id: userId,
      message_id: messageId,
    })
    .select()
    .single();

  if (error || !data) return null;
  return data as SavedMessage;
}

export async function unsaveMessage(
  userId: string,
  messageId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('saved_messages')
    .delete()
    .eq('user_id', userId)
    .eq('message_id', messageId);

  return !error;
}

export async function isMessageSaved(
  userId: string,
  messageId: string,
): Promise<boolean> {
  const { count } = await supabase
    .from('saved_messages')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('message_id', messageId);

  return (count ?? 0) > 0;
}

export async function getThreadMessageCount(
  parentId: string,
): Promise<number> {
  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('parent_id', parentId);

  return count ?? 0;
}

export async function getThreadMessageCounts(
  parentIds: string[],
): Promise<Map<string, number>> {
  const realIds = parentIds.filter((id) => !isTempId(id));
  if (realIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('messages')
    .select('parent_id')
    .in('parent_id', realIds)
    .is('deleted_at', null);

  if (error || !data) return new Map();

  const counts = new Map<string, number>();
  parentIds.forEach((id) => counts.set(id, 0));
  data.forEach((row) => {
    const parentId = row.parent_id as string;
    counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
  });

  return counts;
}

export async function getReplyAuthors(
  parentId: string,
  limit = 3,
): Promise<string[]> {
  const { data } = await supabase
    .from('messages')
    .select('user_id')
    .eq('parent_id', parentId)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (!data) return [];
  return [...new Set(data.map((m) => m.user_id))];
}
