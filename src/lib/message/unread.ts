import { supabase } from '@/lib/supabase';

export async function markChannelRead(channelId: string, userId: string): Promise<void> {
  await supabase.rpc('mark_channel_read' as any, {
    p_channel_id: channelId,
    p_user_id: userId,
  });
}

export async function getUnreadCount(channelId: string, userId: string): Promise<number> {
  const { data } = await supabase.rpc('get_unread_count' as any, {
    p_channel_id: channelId,
    p_user_id: userId,
  });
  return (data as number) ?? 0;
}

export async function getUnreadCounts(
  userId: string,
  channelIds: string[],
): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();

  const { data } = await supabase.rpc('get_unread_counts' as any, {
    p_user_id: userId,
    p_channel_ids: channelIds,
  });

  const counts = new Map<string, number>();
  if (data && Array.isArray(data)) {
    data.forEach((row: { channel_id: string; unread_count: number }) => {
      counts.set(row.channel_id, row.unread_count);
    });
  }
  return counts;
}

export async function markConversationRead(conversationId: string, userId: string): Promise<void> {
  await supabase.rpc('mark_conversation_read' as any, {
    p_conversation_id: conversationId,
    p_user_id: userId,
  });
}
