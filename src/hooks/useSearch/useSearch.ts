import { useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { isSafeSearchQuery } from '@/lib/profile';

export type SearchFilter = 'all' | 'messages' | 'channels' | 'users';

export interface SearchResultItem {
  id: string;
  type: 'message' | 'channel' | 'user';
  title: string;
  subtitle: string;
  avatar_url: string | null;
  link: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface UseSearchReturn {
  query: string;
  results: SearchResultItem[];
  isLoading: boolean;
  activeFilter: SearchFilter;
  search: (query: string) => void;
  setFilter: (filter: SearchFilter) => void;
  clearSearch: () => void;
}

const DEBOUNCE_MS = 300;

export function useSearch(): UseSearchReturn {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<SearchFilter>('all');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const executeSearch = useCallback(async (searchQuery: string, filter: SearchFilter) => {
    if (!searchQuery.trim()) {
      setResults([]);
      setIsLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    const items: SearchResultItem[] = [];

    try {
      if (filter === 'all' || filter === 'messages') {
        const { data: messages } = await supabase
          .from('messages')
          .select('id, channel_id, content, user_id, created_at')
          .ilike('content', `%${searchQuery}%`)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(10);

        if (messages && !controller.signal.aborted) {
          const userIds = Array.from(new Set(messages.map((m) => m.user_id)));
          const channelIds = Array.from(new Set(messages.map((m) => m.channel_id)));

          const [{ data: profiles }, { data: channels }] = await Promise.all([
            userIds.length > 0
              ? supabase.from('profiles').select('id, display_name, avatar_url').in('id', userIds)
              : { data: [] as { id: string; display_name: string | null; avatar_url: string | null }[] },
            channelIds.length > 0
              ? supabase.from('channels').select('id, slug').in('id', channelIds)
              : { data: [] as { id: string; slug: string }[] },
          ]);

          const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
          const channelMap = new Map((channels ?? []).map((c) => [c.id, c]));

          for (const msg of messages) {
            const profile = profileMap.get(msg.user_id);
            const channel = channelMap.get(msg.channel_id);

            items.push({
              id: msg.id,
              type: 'message',
              title: profile?.display_name || 'Unknown',
              subtitle: msg.content,
              avatar_url: profile?.avatar_url || null,
              link: `/channels/${channel?.slug || ''}`,
              created_at: msg.created_at,
            });
          }
        }
      }

      if (filter === 'all' || filter === 'channels') {
        const { data: channels } = await supabase
          .from('channels')
          .select('id, name, slug, description, created_at')
          .ilike('name', `%${searchQuery}%`)
          .order('created_at', { ascending: false })
          .limit(10);

        if (channels && !controller.signal.aborted) {
          for (const ch of channels) {
            items.push({
              id: ch.id,
              type: 'channel',
              title: ch.name,
              subtitle: ch.description || 'No description',
              avatar_url: null,
              link: `/channels/${ch.slug}`,
              created_at: ch.created_at,
            });
          }
        }
      }

      if ((filter === 'all' || filter === 'users') && isSafeSearchQuery(searchQuery)) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, display_name, username, avatar_url')
          .or(`display_name.ilike.%${searchQuery}%,username.ilike.%${searchQuery}%`)
          .limit(10);

        if (profiles && !controller.signal.aborted) {
          for (const p of profiles) {
            items.push({
              id: p.id,
              type: 'user',
              title: p.display_name || p.username || 'Unknown',
              subtitle: p.username ? `@${p.username}` : '',
              avatar_url: p.avatar_url,
              link: `/profile/${p.id}`,
              created_at: '',
            });
          }
        }
      }

      if (!controller.signal.aborted) {
        items.sort((a, b) => {
          if (a.created_at && b.created_at) {
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          }
          return 0;
        });
        setResults(items);
      }
    } catch {
      if (!controller.signal.aborted) {
        setResults([]);
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  const search = useCallback((newQuery: string) => {
    setQuery(newQuery);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!newQuery.trim()) {
      setResults([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    debounceRef.current = setTimeout(() => {
      executeSearch(newQuery, activeFilter);
    }, DEBOUNCE_MS);
  }, [executeSearch, activeFilter]);

  const setFilter = useCallback((filter: SearchFilter) => {
    setActiveFilter(filter);
    if (query.trim()) {
      executeSearch(query, filter);
    }
  }, [query, executeSearch]);

  const clearSearch = useCallback(() => {
    setQuery('');
    setResults([]);
    setIsLoading(false);
    abortRef.current?.abort();
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return {
    query,
    results,
    isLoading,
    activeFilter,
    search,
    setFilter,
    clearSearch,
  };
}
