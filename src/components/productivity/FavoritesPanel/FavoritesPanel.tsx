import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFavorites } from '@/hooks/useFavorites';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { Spinner } from '@/components/ui/Spinner';
import type { FavoriteEntityType } from '@/hooks/useFavorites';
import styles from './FavoritesPanel.module.css';

interface FavoritesPanelProps {
  onClose?: () => void;
}

const ENTITY_LABELS: Record<FavoriteEntityType, string> = {
  channel: 'Channels',
  conversation: 'Conversations',
  message: 'Messages',
};

const ENTITY_ICONS: Record<FavoriteEntityType, React.ReactNode> = {
  channel: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" />
    </svg>
  ),
  conversation: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  ),
  message: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z" />
    </svg>
  ),
};

export function FavoritesPanel({ onClose }: FavoritesPanelProps) {
  const { favorites, isLoading, toggleFavorite } = useFavorites();
  const navigate = useNavigate();

  const grouped = useMemo(() => {
    const groups: Record<FavoriteEntityType, typeof favorites> = {
      channel: [],
      conversation: [],
      message: [],
    };
    for (const fav of favorites) {
      groups[fav.entity_type]?.push(fav);
    }
    return groups;
  }, [favorites]);

  const handleNavigate = useCallback(
    (entityType: FavoriteEntityType, entityId: string) => {
      switch (entityType) {
        case 'channel':
          navigate(`/channels/${entityId}`);
          break;
        case 'conversation':
          navigate(`/dm/${entityId}`);
          break;
        case 'message':
          // Navigate to the message's channel with hash
          navigate(`/messages#message-${entityId}`);
          break;
      }
      onClose?.();
    },
    [navigate, onClose],
  );

  const handleRemove = useCallback(
    async (entityType: FavoriteEntityType, entityId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      await toggleFavorite(entityType, entityId);
    },
    [toggleFavorite],
  );

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3 className={styles.title}>Favorites</h3>
      </div>
      <ScrollArea className={styles.list}>
        {favorites.length === 0 ? (
          <div className={styles.empty}>
            <p>No favorites yet</p>
          </div>
        ) : (
          (Object.keys(grouped) as FavoriteEntityType[]).map((type) => {
            const items = grouped[type];
            if (items.length === 0) return null;
            return (
              <div key={type} className={styles.section}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionIcon}>{ENTITY_ICONS[type]}</span>
                  <span className={styles.sectionTitle}>{ENTITY_LABELS[type]}</span>
                </div>
                {items.map((fav) => (
                  <button
                    key={fav.id}
                    type="button"
                    className={styles.item}
                    onClick={() => handleNavigate(fav.entity_type, fav.entity_id)}
                  >
                    <span className={styles.itemName}>{fav.entity_id}</span>
                    <button
                      type="button"
                      className={styles.removeButton}
                      onClick={(e) => handleRemove(fav.entity_type, fav.entity_id, e)}
                      aria-label="Remove from favorites"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </button>
                ))}
              </div>
            );
          })
        )}
      </ScrollArea>
    </div>
  );
}
