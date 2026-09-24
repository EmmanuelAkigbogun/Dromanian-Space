import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import type { UUID } from '@/types';

export type FavoriteEntityType = 'channel' | 'conversation' | 'message';

export interface Favorite {
  id: UUID;
  user_id: UUID;
  entity_type: FavoriteEntityType;
  entity_id: UUID;
  sort_order: number;
  created_at: string;
}

interface UseFavoritesReturn {
  favorites: Favorite[];
  isLoading: boolean;
  error: string | null;
  toggleFavorite: (entityType: FavoriteEntityType, entityId: UUID) => Promise<boolean>;
  isFavorite: (entityType: FavoriteEntityType, entityId: UUID) => boolean;
  reorderFavorites: (orderedIds: UUID[]) => Promise<void>;
  refreshFavorites: () => Promise<void>;
}

export function useFavorites(): UseFavoritesReturn {
  const { userId } = useAuth();
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFavorites = useCallback(async () => {
    if (!userId) return;
    setIsLoading(true);
    setError(null);

    try {
      const { data, error: fetchError } = await supabase
        .from('user_favorites' as any)
        .select('*')
        .eq('user_id', userId)
        .order('sort_order', { ascending: true });

      if (fetchError) throw fetchError;
      setFavorites((data as unknown as Favorite[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch favorites');
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchFavorites();
  }, [fetchFavorites]);

  const isFavorite = useCallback(
    (entityType: FavoriteEntityType, entityId: UUID) => {
      return favorites.some((f) => f.entity_type === entityType && f.entity_id === entityId);
    },
    [favorites],
  );

  const toggleFavorite = useCallback(
    async (entityType: FavoriteEntityType, entityId: UUID): Promise<boolean> => {
      if (!userId) return false;
      setError(null);

      const existing = favorites.find(
        (f) => f.entity_type === entityType && f.entity_id === entityId,
      );

      try {
        if (existing) {
          const { error: deleteError } = await supabase
            .from('user_favorites' as any)
            .delete()
            .eq('id', existing.id);

          if (deleteError) throw deleteError;
          setFavorites((prev) => prev.filter((f) => f.id !== existing.id));
          return false;
        } else {
          const maxSortOrder = favorites.length > 0
            ? Math.max(...favorites.map((f) => f.sort_order)) + 1
            : 0;

          const { data, error: insertError } = await supabase
            .from('user_favorites' as any)
            .insert({
              user_id: userId,
              entity_type: entityType,
              entity_id: entityId,
              sort_order: maxSortOrder,
            })
            .select()
            .single();

          if (insertError) throw insertError;
          setFavorites((prev) => [...prev, data as unknown as Favorite]);
          return true;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to toggle favorite');
        return existing ? true : false;
      }
    },
    [userId, favorites],
  );

  const reorderFavorites = useCallback(
    async (orderedIds: UUID[]): Promise<void> => {
      if (!userId) return;
      setError(null);

      try {
        const updates = orderedIds.map((id, index) =>
          supabase
            .from('user_favorites' as any)
            .update({ sort_order: index })
            .eq('id', id)
            .eq('user_id', userId),
        );

        await Promise.all(updates);

        setFavorites((prev) => {
          const map = new Map(prev.map((f) => [f.id, f]));
          return orderedIds
            .map((id, index) => {
              const fav = map.get(id);
              return fav ? { ...fav, sort_order: index } : null;
            })
            .filter(Boolean) as Favorite[];
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reorder favorites');
      }
    },
    [userId],
  );

  return useMemo(
    () => ({
      favorites,
      isLoading,
      error,
      toggleFavorite,
      isFavorite,
      reorderFavorites,
      refreshFavorites: fetchFavorites,
    }),
    [favorites, isLoading, error, toggleFavorite, isFavorite, reorderFavorites, fetchFavorites],
  );
}
