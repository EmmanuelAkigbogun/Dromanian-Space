import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '@/hooks/useNotifications';
import { Avatar } from '@/components/ui/Avatar';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { formatRelativeTime } from '@/utils';
import type { TypedNotification, NotificationCategory } from '@/features/notifications/service';
import styles from './Notifications.module.css';

const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  messaging: 'Messaging',
  workspace: 'Workspace',
  channels: 'Channels',
  projects: 'Projects',
  tasks: 'Tasks',
  calendar: 'Calendar',
};

const CATEGORY_TABS: Array<{ id: NotificationCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'messaging', label: 'Messaging' },
  { id: 'channels', label: 'Channels' },
  { id: 'projects', label: 'Projects' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'workspace', label: 'Workspace' },
];

export function Notifications() {
  const navigate = useNavigate();
  const {
    notifications,
    loading,
    loadingMore,
    hasMore,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    loadMore,
  } = useNotifications();

  const [activeCategory, setActiveCategory] = useState<NotificationCategory | 'all'>('all');
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loadMoreRef.current || !hasMore || loadingMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { threshold: 0.1 },
    );
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, loadMore]);

  const filteredNotifications = activeCategory === 'all'
    ? notifications
    : notifications.filter((n) => n.category === activeCategory);

  const handleClick = useCallback(async (notification: TypedNotification) => {
    if (!notification.read) {
      await markAsRead(notification.id);
    }
    if (notification.link) {
      navigate(notification.link);
    }
  }, [markAsRead, navigate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, notification: TypedNotification) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick(notification);
      }
    },
    [handleClick],
  );

  const hasUnread = notifications.some((n) => !n.read);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>Notifications</h2>
        <button
          type="button"
          className={styles.markAllRead}
          onClick={markAllAsRead}
          disabled={!hasUnread || loading}
        >
          Mark all as read
        </button>
      </div>

      <div className={styles.categoryTabs} role="tablist" aria-label="Notification categories">
        {CATEGORY_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`${styles.categoryTab} ${activeCategory === tab.id ? styles.categoryTabActive : ''}`}
            onClick={() => setActiveCategory(tab.id)}
            role="tab"
            aria-selected={activeCategory === tab.id}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className={styles.list} role="list" aria-label="Notifications list">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={styles.skeletonItem} role="listitem">
              <Skeleton variant="circle" width={40} height={40} />
              <div className={styles.skeletonContent}>
                <Skeleton variant="text" width="60%" />
                <Skeleton variant="text" width="90%" />
                <Skeleton variant="text" width="30%" />
              </div>
            </div>
          ))
        ) : filteredNotifications.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            </div>
            <h3 className={styles.emptyTitle}>No notifications yet</h3>
            <p className={styles.emptyDescription}>
              When you receive notifications, they&apos;ll appear here.
            </p>
          </div>
        ) : (
          <>
            {filteredNotifications.map((notification) => (
              <div
                key={notification.id}
                className={`${styles.item} ${!notification.read ? styles.unread : ''}`}
                role="listitem"
                tabIndex={0}
                onClick={() => handleClick(notification)}
                onKeyDown={(e) => handleKeyDown(e, notification)}
                aria-label={`${notification.read ? '' : 'Unread: '}${notification.title}. ${notification.message}`}
              >
                <div className={styles.itemAvatar}>
                  <Avatar size="sm" name={notification.actor_id || ''} />
                </div>
                <div className={styles.itemContent}>
                  <span className={styles.itemTitle}>{notification.title}</span>
                  {notification.message && (
                    <span className={styles.itemMessage}>{notification.message}</span>
                  )}
                  <div className={styles.itemMeta}>
                    <span className={styles.itemTime}>
                      {formatRelativeTime(notification.created_at)}
                    </span>
                    <span className={`${styles.categoryBadge} ${styles[`category${notification.category.charAt(0).toUpperCase() + notification.category.slice(1)}`] || ''}`}>
                      {CATEGORY_LABELS[notification.category] || notification.category}
                    </span>
                  </div>
                </div>
                <button
                  className={styles.deleteButton}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteNotification(notification.id);
                  }}
                  type="button"
                  aria-label={`Delete notification: ${notification.title}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
            {hasMore && (
              <div ref={loadMoreRef} className={styles.loadMoreTrigger}>
                <Spinner size="sm" label="Loading more notifications" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
