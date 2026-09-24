import { supabase } from '@/lib/supabase';

export interface SearchResult {
  message_id: string;
  channel_id: string;
  content: string;
  user_id: string;
  created_at: string;
  channel_name?: string;
}

/**
 * Search messages across channels the user is a member of.
 * Uses PostgreSQL full-text search via RPC.
 */
export async function searchMessages(
  userId: string,
  query: string,
  options?: { limit?: number; channelId?: string },
): Promise<SearchResult[]> {
  const limit = options?.limit ?? 20;

  let dbQuery = supabase
    .from('messages')
    .select('id, channel_id, content, user_id, created_at')
    .ilike('content', `%${query}%`)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (options?.channelId) {
    dbQuery = dbQuery.eq('channel_id', options.channelId);
  }

  // Only search in channels the user is a member of
  const { data: memberChannels } = await supabase
    .from('channel_members')
    .select('channel_id')
    .eq('user_id', userId);

  if (!memberChannels || memberChannels.length === 0) return [];

  const channelIds = memberChannels.map((c) => c.channel_id);
  dbQuery = dbQuery.in('channel_id', channelIds);

  const { data, error } = await dbQuery;
  if (error || !data) return [];

  return data.map((row) => ({
    message_id: row.id,
    channel_id: row.channel_id,
    content: row.content,
    user_id: row.user_id,
    created_at: row.created_at,
  }));
}

/**
 * Record a search index entry (prepare for future full-text search).
 * Currently stores in messages table — no separate index needed.
 */
export function prepareSearchIndex(_messageId: string): void {
  // Future: If using a dedicated search service (Meilisearch, Typesense, etc.)
  // this would push the message content to the search index.
  // For now, Supabase's ilike search on the messages table is sufficient
  // for the initial implementation.
}
