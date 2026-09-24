import { supabase } from '@/lib/supabase';
import type { Reaction } from '@/types';

const REACTION_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  reactions: Reaction[];
  fetchedAt: number;
}

// A message list can render dozens of messages at once, each of which used to
// fire its own reactions query on mount. Batch mount-time fetches into a single
// `getReactionsByMessageIds` call and cache the result briefly.
const reactionCache = new Map<string, CacheEntry>();

let pendingIds = new Set<string>();
const pendingResolvers = new Map<string, Array<(reactions: Reaction[]) => void>>();
let flushScheduled = false;

function flushPending() {
  flushScheduled = false;
  if (pendingIds.size === 0) return;

  const ids = Array.from(pendingIds);
  const resolvers = Array.from(pendingResolvers.entries());
  pendingIds = new Set();
  pendingResolvers.clear();

  getReactionsByMessageIds(ids)
    .then((grouped) => {
      const now = Date.now();
      for (const [id, res] of resolvers) {
        const reactions = grouped.get(id) ?? [];
        reactionCache.set(id, { reactions, fetchedAt: now });
        res.forEach((fn) => fn(reactions));
      }
    })
    .catch(() => {
      resolvers.forEach(([, res]) => res.forEach((fn) => fn([])));
    });
}

function queueReactionFetch(messageId: string, resolve: (reactions: Reaction[]) => void) {
  const existing = pendingResolvers.get(messageId);
  if (existing) {
    existing.push(resolve);
  } else {
    pendingResolvers.set(messageId, [resolve]);
    pendingIds.add(messageId);
  }
  if (!flushScheduled) {
    flushScheduled = true;
    setTimeout(flushPending, 30);
  }
}

export function invalidateMessageReactions(messageId: string) {
  reactionCache.delete(messageId);
}

export async function addReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<Reaction | null> {
  const { data: existing } = await supabase
    .from('reactions')
    .select('id')
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .eq('emoji', emoji)
    .maybeSingle();

  if (existing) {
    await removeReaction(messageId, userId, emoji);
    return null;
  }

  const { data, error } = await supabase
    .from('reactions')
    .insert({
      message_id: messageId,
      user_id: userId,
      emoji,
    })
    .select()
    .single();

  if (error || !data) {
    console.error('addReaction failed:', error?.message, error?.code);
    return null;
  }
  invalidateMessageReactions(messageId);
  return data as Reaction;
}

export async function removeReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('reactions')
    .delete()
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .eq('emoji', emoji);

  if (error) {
    console.error('removeReaction failed:', error.message, error.code);
    return false;
  }
  invalidateMessageReactions(messageId);
  return !error;
}

export async function getMessageReactions(
  messageId: string,
): Promise<Reaction[]> {
  const cached = reactionCache.get(messageId);
  if (cached && Date.now() - cached.fetchedAt < REACTION_CACHE_TTL_MS) {
    return cached.reactions;
  }
  return new Promise<Reaction[]>((resolve) => queueReactionFetch(messageId, resolve));
}

export async function getReactionsByMessageIds(
  messageIds: string[],
): Promise<Map<string, Reaction[]>> {
  if (messageIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('reactions')
    .select('*')
    .in('message_id', messageIds)
    .order('created_at', { ascending: true });

  if (error || !data) {
    if (error) console.error('getReactionsByMessageIds failed:', error.message, error.code);
    return new Map();
  }

  const grouped = new Map<string, Reaction[]>();
  messageIds.forEach((id) => grouped.set(id, []));
  (data as Reaction[]).forEach((reaction) => {
    const existing = grouped.get(reaction.message_id) ?? [];
    existing.push(reaction);
    grouped.set(reaction.message_id, existing);
  });

  return grouped;
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  userIds: string[];
  hasOwn: boolean;
}

export function groupReactions(
  reactions: Reaction[],
  currentUserId: string,
): ReactionGroup[] {
  const map = new Map<string, ReactionGroup>();

  reactions.forEach((r) => {
    const existing = map.get(r.emoji);
    if (existing) {
      if (!existing.userIds.includes(r.user_id)) {
        existing.userIds.push(r.user_id);
        existing.count++;
      }
      if (r.user_id === currentUserId) existing.hasOwn = true;
    } else {
      map.set(r.emoji, {
        emoji: r.emoji,
        count: 1,
        userIds: [r.user_id],
        hasOwn: r.user_id === currentUserId,
      });
    }
  });

  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}
