import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRecentActivity } from '@/hooks/useRecentActivity';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { Spinner } from '@/components/ui/Spinner';
import { formatRelativeTime } from '@/utils';
import type { RecentActivityEntityType } from '@/hooks/useRecentActivity';
import styles from './RecentPanel.module.css';

const ENTITY_ICONS: Record<RecentActivityEntityType, React.ReactNode> = {
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
  thread: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      <path d="M12 7v4M8 11h8" />
    </svg>
  ),
  file: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  ),
};

interface RecentPanelProps {
  onClose?: () => void;
}

export function RecentPanel({ onClose }: RecentPanelProps) {
  const { recentItems, isLoading } = useRecentActivity();
  const navigate = useNavigate();

  const handleNavigate = useCallback(
    (item: typeof recentItems[0]) => {
      navigate(item.url);
      onClose?.();
    },
    [navigate, onClose],
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
        <h3 className={styles.title}>Recent</h3>
      </div>
      <ScrollArea className={styles.list}>
        {recentItems.length === 0 ? (
          <div className={styles.empty}>
            <p>No recent activity</p>
          </div>
        ) : (
          recentItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.item}
              onClick={() => handleNavigate(item)}
            >
              <span className={styles.icon}>
                {ENTITY_ICONS[item.entity_type]}
              </span>
              <div className={styles.content}>
                <span className={styles.name}>{item.name}</span>
                <span className={styles.time}>{formatRelativeTime(item.accessed_at)}</span>
              </div>
            </button>
          ))
        )}
      </ScrollArea>
    </div>
  );
}
