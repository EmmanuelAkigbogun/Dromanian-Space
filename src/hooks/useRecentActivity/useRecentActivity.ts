import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import type { UUID } from '@/types';

export type RecentActivityEntityType = 'channel' | 'conversation' | 'thread' | 'file';

export interface RecentActivity {
  id: UUID;
  user_id: UUID;
  entity_type: RecentActivityEntityType;
  entity_id: UUID;
  entity_name: string;
  entity_url: string;
  name: string;
  url: string;
  accessed_at: string;
}

interface UseRecentActivityReturn {
  recentItems: RecentActivity[];
  isLoading: boolean;
  error: string | null;
  recordAccess: (
    entityType: RecentActivityEntityType,
    entityId: UUID,
    name: string,
    url: string,
  ) => Promise<void>;
  refreshRecent: () => Promise<void>;
}

export function useRecentActivity(): UseRecentActivityReturn {
  const { userId } = useAuth();
  const [recentItems, setRecentItems] = useState<RecentActivity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRecent = useCallback(async () => {
    if (!userId) return;
    setIsLoading(true);
    setError(null);

    try {
      const { data, error: fetchError } = await supabase
        .from('recent_activity' as any)
        .select('*')
        .eq('user_id', userId)
        .order('accessed_at', { ascending: false })
        .limit(50);

      if (fetchError) throw fetchError;
      setRecentItems((data as unknown as RecentActivity[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch recent activity');
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchRecent();
  }, [fetchRecent]);

  const recordAccess = useCallback(
    async (
      entityType: RecentActivityEntityType,
      entityId: UUID,
      name: string,
      url: string,
    ): Promise<void> => {
      if (!userId) return;
      setError(null);

      try {
        const now = new Date().toISOString();

        // Check if an entry already exists for this entity
        const { data: existing } = await supabase
          .from('recent_activity' as any)
          .select('id')
          .eq('user_id', userId)
          .eq('entity_type', entityType)
          .eq('entity_id', entityId)
          .maybeSingle();

        if (existing) {
          const { error: updateError } = await supabase
            .from('recent_activity' as any)
            .update({ accessed_at: now, entity_name: name, entity_url: url })
            .eq('id', (existing as any).id);
          if (updateError) throw updateError;
        } else {
          const { error: insertError } = await supabase
            .from('recent_activity' as any)
            .insert({
              user_id: userId,
              entity_type: entityType,
              entity_id: entityId,
              entity_name: name,
              entity_url: url,
              accessed_at: now,
            });
          if (insertError) throw insertError;
        }

        // Refresh the list
        fetchRecent();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to record access');
      }
    },
    [userId, fetchRecent],
  );

  return useMemo(
    () => ({
      recentItems,
      isLoading,
      error,
      recordAccess,
      refreshRecent: fetchRecent,
    }),
    [recentItems, isLoading, error, recordAccess, fetchRecent],
  );
}
