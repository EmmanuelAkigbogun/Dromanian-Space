import { useState, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import type { UUID } from '@/types';

export interface Draft {
  id: UUID;
  user_id: UUID;
  channel_id: UUID | null;
  conversation_id: UUID | null;
  thread_id: UUID | null;
  content: string;
  created_at: string;
  updated_at: string;
}

interface UseDraftsReturn {
  saveDraft: (
    content: string,
    ids: { channelId?: UUID; conversationId?: UUID; threadId?: UUID },
  ) => Promise<void>;
  getDraft: (
    ids: { channelId?: UUID; conversationId?: UUID; threadId?: UUID },
  ) => Promise<Draft | null>;
  deleteDraft: (
    ids: { channelId?: UUID; conversationId?: UUID; threadId?: UUID },
  ) => Promise<void>;
  hasDraft: (ids: { channelId?: UUID; conversationId?: UUID; threadId?: UUID }) => boolean;
}

function draftKey(ids: { channelId?: UUID; conversationId?: UUID; threadId?: UUID }): string {
  if (ids.threadId) return `thread:${ids.threadId}`;
  if (ids.conversationId) return `conversation:${ids.conversationId}`;
  if (ids.channelId) return `channel:${ids.channelId}`;
  return '';
}

export function useDrafts(): UseDraftsReturn {
  const { userId } = useAuth();
  const [draftCache, setDraftCache] = useState<Map<string, Draft>>(new Map());
  const debounceTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const getDraft = useCallback(
    async (ids: { channelId?: UUID; conversationId?: UUID; threadId?: UUID }): Promise<Draft | null> => {
      if (!userId) return null;

      const key = draftKey(ids);
      if (!key) return null;

      const cached = draftCache.get(key);
      if (cached) return cached;

      try {
        let query = supabase
          .from('user_drafts' as any)
          .select('*')
          .eq('user_id', userId);

        if (ids.threadId) {
          query = query.eq('thread_id', ids.threadId);
        } else if (ids.conversationId) {
          query = query.eq('conversation_id', ids.conversationId).is('thread_id', null);
        } else if (ids.channelId) {
          query = query.eq('channel_id', ids.channelId).is('conversation_id', null).is('thread_id', null);
        }

        const { data, error } = await query.maybeSingle();
        if (error) throw error;

        const draft = data as Draft | null;
        if (draft) {
          setDraftCache((prev) => new Map(prev).set(key, draft));
        }
        return draft;
      } catch {
        return null;
      }
    },
    [userId, draftCache],
  );

  const saveDraft = useCallback(
    async (
      content: string,
      ids: { channelId?: UUID; conversationId?: UUID; threadId?: UUID },
    ): Promise<void> => {
      if (!userId) return;

      const key = draftKey(ids);
      if (!key) return;

      const existing = draftCache.get(key);
      const now = new Date().toISOString();

      const draftData = {
        user_id: userId,
        channel_id: ids.channelId ?? null,
        conversation_id: ids.conversationId ?? null,
        thread_id: ids.threadId ?? null,
        content,
        updated_at: now,
      };

      try {
        if (existing) {
          const { error } = await supabase
            .from('user_drafts' as any)
            .update(draftData)
            .eq('id', existing.id);
          if (error) throw error;
          setDraftCache((prev) => new Map(prev).set(key, { ...existing, ...draftData }));
        } else {
          const { data, error } = await supabase
            .from('user_drafts' as any)
            .insert({ ...draftData })
            .select()
            .single();
          if (error) throw error;
          setDraftCache((prev) => new Map(prev).set(key, data as unknown as Draft));
        }
      } catch {
        // silently fail draft saves
      }
    },
    [userId, draftCache],
  );

  const deleteDraft = useCallback(
    async (ids: { channelId?: UUID; conversationId?: UUID; threadId?: UUID }): Promise<void> => {
      if (!userId) return;

      const key = draftKey(ids);
      if (!key) return;

      const existing = draftCache.get(key);
      if (!existing) return;

      try {
        const { error } = await supabase
          .from('user_drafts' as any)
          .delete()
          .eq('id', existing.id);
        if (error) throw error;
        setDraftCache((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      } catch {
        // silently fail
      }
    },
    [userId, draftCache],
  );

  const hasDraft = useCallback(
    (ids: { channelId?: UUID; conversationId?: UUID; threadId?: UUID }): boolean => {
      const key = draftKey(ids);
      if (!key) return false;
      const draft = draftCache.get(key);
      return !!draft && draft.content.trim().length > 0;
    },
    [draftCache],
  );

  const debouncedSave = useCallback(
    (
      content: string,
      ids: { channelId?: UUID; conversationId?: UUID; threadId?: UUID },
    ): Promise<void> => {
      return new Promise<void>((resolve) => {
        const key = draftKey(ids);
        if (!key) { resolve(); return; }

        const existing = debounceTimerRef.current.get(key);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
          if (content.trim().length === 0) {
            deleteDraft(ids).then(resolve);
          } else {
            saveDraft(content, ids).then(resolve);
          }
        }, 1000);

        debounceTimerRef.current.set(key, timer);
      });
    },
    [saveDraft, deleteDraft],
  );

  return useMemo(
    () => ({
      saveDraft: debouncedSave,
      getDraft,
      deleteDraft,
      hasDraft,
    }),
    [debouncedSave, getDraft, deleteDraft, hasDraft],
  );
}
