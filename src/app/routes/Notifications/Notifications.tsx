import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '@/hooks/useNotifications';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { NotificationItem } from '@/components/notification-center/NotificationItem';
import { PushToggle } from '@/components/notification-center/PushToggle';
import { InstallApp } from '@/components/pwa/InstallApp';
import {
  groupNotifications,
  notificationGroupMatches,
  summarizeNotificationGroups,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABELS,
  type NotificationCategory,
  type NotificationFilter,
  type NotificationGroup,
} from '@/features/notifications/presentation';
import styles from './Notifications.module.css';

const FILTER_TABS: Array<{ id: NotificationFilter; label: string }> = [
  { id: 'action', label: 'Action required' },
  { id: 'unread', label: 'Unread' },
  { id: 'all', label: 'All activity' },
];

export function Notifications() {
  const navigate = useNavigate();
  const {
    notifications,
    unreadCount,
    loading,
    loadingMore,
    hasMore,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    loadMore,
  } = useNotifications();
  const [activeFilter, setActiveFilter] = useState<NotificationFilter>('unread');
  const [activeCategory, setActiveCategory] = useState<NotificationCategory | 'all'>('all');
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  const groups = useMemo(() => groupNotifications(notifications), [notifications]);
  const summary = useMemo(() => summarizeNotificationGroups(groups), [groups]);
  const filteredGroups = useMemo(
    () => groups.filter((group) => notificationGroupMatches(group, activeFilter, activeCategory)),
    [activeCategory, activeFilter, groups],
  );

  useEffect(() => {
    if (loading || initializedRef.current) return;
    setActiveFilter(summary.actionUnread > 0 ? 'action' : summary.unread > 0 ? 'unread' : 'all');
    initializedRef.current = true;
  }, [loading, summary.actionUnread, summary.unread]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMore || loadingMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { threshold: 0.1 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [filteredGroups.length, hasMore, loadingMore, loadMore]);

  const handleOpen = useCallback(async (group: NotificationGroup) => {
    const unreadIds = group.items.filter((item) => !item.read).map((item) => item.id);
    if (group.primary.link) navigate(group.primary.link);
    if (unreadIds.length > 0) {
      void Promise.allSettled(unreadIds.map((id) => markAsRead(id)));
    }
  }, [markAsRead, navigate]);

  const handleDismiss = useCallback((notificationId: string) => {
    void deleteNotification(notificationId);
  }, [deleteNotification]);

  const filterCount = (filter: NotificationFilter) => {
    if (filter === 'action') return summary.action;
    if (filter === 'unread') return unreadCount;
    return summary.total;
  };
  const hasUnread = unreadCount > 0;
  const emptyTitle = activeFilter === 'action'
    ? 'Nothing needs your action'
    : activeFilter === 'unread'
      ? 'You are all caught up'
      : 'No notifications yet';
  const emptyDescription = activeCategory === 'all'
    ? activeFilter === 'action'
      ? 'Approvals, invitations, access requests, failures and overdue work will be prioritized here.'
      : 'New mentions, assignments and updates will appear here.'
    : `No ${NOTIFICATION_CATEGORY_LABELS[activeCategory].toLocaleLowerCase()} notifications match this view.`;

  return (
    <main className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Notifications</h1>
          <p className={styles.subtitle}>Important work first, routine updates grouped together.</p>
        </div>
        <div className={styles.headerActions}>
          <InstallApp />
          <PushToggle />
          <button
            type="button"
            className={styles.markAllRead}
            onClick={() => void markAllAsRead()}
            disabled={!hasUnread || loading}
          >
            Mark all as read
          </button>
        </div>
      </header>

      <section className={styles.summaryGrid} aria-label="Notification summary">
        <button
          type="button"
          className={`${styles.summaryCard} ${styles.actionCard} ${activeFilter === 'action' ? styles.summaryCardActive : ''}`}
          onClick={() => setActiveFilter('action')}
        >
          <span className={styles.summaryLabel}>Action required</span>
          <strong>{summary.action}</strong>
          <small>{summary.actionUnread} new</small>
        </button>
        <button
          type="button"
          className={`${styles.summaryCard} ${activeFilter === 'unread' ? styles.summaryCardActive : ''}`}
          onClick={() => setActiveFilter('unread')}
        >
          <span className={styles.summaryLabel}>Unread</span>
          <strong>{unreadCount}</strong>
          <small>across all activity</small>
        </button>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Important</span>
          <strong>{summary.important}</strong>
          <small>mentions, assignments, events</small>
        </div>
      </section>

      <section className={styles.inbox} aria-labelledby="notification-inbox-heading">
        <div className={styles.inboxHeader}>
          <h2 id="notification-inbox-heading">Inbox</h2>
          <label className={styles.categoryFilter}>
            <span className={styles.srOnly}>Category</span>
            <select
              value={activeCategory}
              onChange={(event) => setActiveCategory(event.target.value as NotificationCategory | 'all')}
              aria-label="Filter notifications by category"
            >
              <option value="all">All categories ({summary.total})</option>
              {NOTIFICATION_CATEGORIES.filter((category) => summary.categories[category] > 0).map((category) => (
                <option key={category} value={category}>
                  {NOTIFICATION_CATEGORY_LABELS[category]} ({summary.categories[category]})
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className={styles.filterTabs} role="tablist" aria-label="Notification priority">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.id}
              className={`${styles.filterTab} ${activeFilter === tab.id ? styles.filterTabActive : ''}`}
              onClick={() => setActiveFilter(tab.id)}
              role="tab"
              aria-selected={activeFilter === tab.id}
              type="button"
            >
              {tab.label}<span>{filterCount(tab.id)}</span>
            </button>
          ))}
        </div>

        <div className={styles.list} role="list" aria-label="Notifications list">
          {loading ? (
            Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className={styles.skeletonItem} role="listitem">
                <Skeleton variant="circle" width={36} height={36} />
                <div className={styles.skeletonContent}>
                  <Skeleton variant="text" width="60%" />
                  <Skeleton variant="text" width="90%" />
                  <Skeleton variant="text" width="30%" />
                </div>
              </div>
            ))
          ) : filteredGroups.length === 0 ? (
            <>
              <div className={styles.empty}>
                <div className={styles.emptyIcon} aria-hidden="true">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="m5 12 4 4L19 6" />
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                </div>
                <h3>{emptyTitle}</h3>
                <p>{emptyDescription}</p>
                {(activeFilter !== 'all' || activeCategory !== 'all') && summary.total > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveFilter('all');
                      setActiveCategory('all');
                    }}
                  >
                    Show all notifications
                  </button>
                ) : null}
              </div>
              {hasMore ? (
                <div ref={loadMoreRef} className={styles.loadMoreTrigger}>
                  <Spinner size="sm" label="Looking for older matching notifications" />
                </div>
              ) : null}
            </>
          ) : (
            <>
              {filteredGroups.map((group) => (
                <NotificationItem
                  key={group.key}
                  group={group}
                  onOpen={handleOpen}
                  onDismiss={handleDismiss}
                />
              ))}
              {hasMore ? (
                <div ref={loadMoreRef} className={styles.loadMoreTrigger}>
                  <Spinner size="sm" label="Loading more notifications" />
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
