import { useState, useCallback } from 'react';
import { useMentions } from '@/hooks/useMentions';
import { Badge } from '@/components/ui/Badge';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { SavedMessagesPanel } from '../SavedMessagesPanel/SavedMessagesPanel';
import { PinnedMessagesPanel } from '@/components/message/PinnedMessagesPanel';
import { FavoritesPanel } from '../FavoritesPanel/FavoritesPanel';
import { MentionsPanel } from '../MentionsPanel/MentionsPanel';
import { RecentPanel } from '../RecentPanel/RecentPanel';
import styles from './ProductivitySidebar.module.css';

type ProductivityPanel = 'saved' | 'pinned' | 'favorites' | 'mentions' | 'recent' | null;

interface ProductivitySidebarProps {
  className?: string;
}

const NAV_ITEMS: Array<{ id: ProductivityPanel; label: string; icon: React.ReactNode }> = [
  {
    id: 'saved',
    label: 'Saved',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
      </svg>
    ),
  },
  {
    id: 'pinned',
    label: 'Pinned',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2L12 12M12 2L9 5M12 2L15 5" />
        <path d="M5 10H19L18 22H6L5 10Z" />
      </svg>
    ),
  },
  {
    id: 'favorites',
    label: 'Favorites',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z" />
      </svg>
    ),
  },
  {
    id: 'mentions',
    label: 'Mentions',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="4" />
        <path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-3.92 7.94" />
      </svg>
    ),
  },
  {
    id: 'recent',
    label: 'Recent',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
  },
];

export function ProductivitySidebar({ className }: ProductivitySidebarProps) {
  const [activePanel, setActivePanel] = useState<ProductivityPanel>(null);
  const { unreadCount } = useMentions();

  const handleToggle = useCallback((panel: ProductivityPanel) => {
    setActivePanel((prev) => (prev === panel ? null : panel));
  }, []);

  const classes = [styles.sidebar, className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <div className={styles.navList}>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`${styles.navItem} ${activePanel === item.id ? styles.navItemActive : ''}`}
            onClick={() => handleToggle(item.id)}
            title={item.label}
            aria-label={item.label}
            aria-expanded={activePanel === item.id}
          >
            <span className={styles.navIcon}>{item.icon}</span>
            <span className={styles.navLabel}>{item.label}</span>
            {item.id === 'mentions' && unreadCount > 0 && (
              <Badge variant="error" size="sm" className={styles.badge}>
                {unreadCount > 99 ? '99+' : unreadCount}
              </Badge>
            )}
          </button>
        ))}
      </div>

      {activePanel && (
        <div className={styles.panelContainer}>
          {activePanel === 'saved' && <SavedMessagesPanel />}
          {activePanel === 'pinned' && <PinnedMessagesPanel />}
          {activePanel === 'favorites' && <FavoritesPanel />}
          {activePanel === 'mentions' && <MentionsPanel />}
          {activePanel === 'recent' && <RecentPanel />}
        </div>
      )}
    </div>
  );
}
