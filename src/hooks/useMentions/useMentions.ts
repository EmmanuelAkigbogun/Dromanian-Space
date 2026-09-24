import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import type { UUID } from '@/types';

export interface UserMention {
  id: UUID;
  user_id: UUID;
  message_id: UUID;
  channel_id: UUID;
  mentioned_by: UUID;
  content: string;
  channel_name: string;
  read: boolean;
  created_at: string;
}

interface UseMentionsReturn {
  mentions: UserMention[];
  unreadCount: number;
  isLoading: boolean;
  error: string | null;
  markAsRead: (mentionId: UUID) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  loadMore: () => Promise<void>;
  hasMore: boolean;
  refreshMentions: () => Promise<void>;
}

const PAGE_SIZE = 20;

export function useMentions(): UseMentionsReturn {
  const { userId } = useAuth();
  const [mentions, setMentions] = useState<UserMention[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);

  const fetchMentions = useCallback(
    async (pageNum: number = 0, append: boolean = false) => {
      if (!userId) return;
      setIsLoading(true);
      setError(null);

      try {
        const from = pageNum * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;

        const { data, error: fetchError, count } = await supabase
          .from('user_mentions' as any)
          .select('*', { count: 'exact' })
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .range(from, to);

        if (fetchError) throw fetchError;

        const fetched = (data as unknown as UserMention[]) ?? [];

        if (append) {
          setMentions((prev) => [...prev, ...fetched]);
        } else {
          setMentions(fetched);
        }

        setHasMore(fetched.length === PAGE_SIZE);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch mentions');
      } finally {
        setIsLoading(false);
      }
    },
    [userId],
  );

  const fetchUnreadCount = useCallback(async () => {
    if (!userId) return;

    try {
      const { count, error: countError } = await supabase
        .from('user_mentions' as any)
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('read', false);

      if (countError) throw countError;
      setUnreadCount(count ?? 0);
    } catch {
      // silently fail
    }
  }, [userId]);

  useEffect(() => {
    fetchMentions(0);
    fetchUnreadCount();
  }, [fetchMentions, fetchUnreadCount]);

  const markAsRead = useCallback(
    async (mentionId: UUID): Promise<void> => {
      try {
        const { error: updateError } = await supabase
          .from('user_mentions' as any)
          .update({ read: true })
          .eq('id', mentionId);
        if (updateError) throw updateError;

        setMentions((prev) =>
          prev.map((m) => (m.id === mentionId ? { ...m, read: true } : m)),
        );
        setUnreadCount((prev) => Math.max(0, prev - 1));
      } catch {
        // silently fail
      }
    },
    [],
  );

  const markAllAsRead = useCallback(async (): Promise<void> => {
    if (!userId) return;

    try {
      const { error: updateError } = await supabase
        .from('user_mentions' as any)
        .update({ read: true })
        .eq('user_id', userId)
        .eq('read', false);
      if (updateError) throw updateError;

      setMentions((prev) => prev.map((m) => ({ ...m, read: true })));
      setUnreadCount(0);
    } catch {
      // silently fail
    }
  }, [userId]);

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoading) return;
    const nextPage = page + 1;
    setPage(nextPage);
    await fetchMentions(nextPage, true);
  }, [hasMore, isLoading, page, fetchMentions]);

  return useMemo(
    () => ({
      mentions,
      unreadCount,
      isLoading,
      error,
      markAsRead,
      markAllAsRead,
      loadMore,
      hasMore,
      refreshMentions: () => {
        setPage(0);
        return Promise.all([fetchMentions(0), fetchUnreadCount()]).then();
      },
    }),
    [mentions, unreadCount, isLoading, error, markAsRead, markAllAsRead, loadMore, hasMore, fetchMentions, fetchUnreadCount],
  );
}
