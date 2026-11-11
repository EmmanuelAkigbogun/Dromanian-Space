import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '@/hooks/useNotifications';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { NotificationItem } from '@/components/notification-center/NotificationItem';
import { Portal } from '@/lib/overlay/Portal';
import { useFocusTrap } from '@/lib/overlay/useFocusTrap';
import { useOverlayStack } from '@/lib/overlay/useOverlayStack';
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
import styles from './NotificationCenter.module.css';

interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
}

const FILTER_TABS: Array<{ id: NotificationFilter; label: string }> = [
  { id: 'action', label: 'Action required' },
  { id: 'unread', label: 'Unread' },
  { id: 'all', label: 'All' },
];

export function NotificationCenter({ open, onClose }: NotificationCenterProps) {
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
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const initializedForOpenRef = useRef(false);
  const containerRef = useFocusTrap(open);
  const overlayId = useOverlayStack(open);

  const groups = useMemo(() => groupNotifications(notifications), [notifications]);
  const summary = useMemo(() => summarizeNotificationGroups(groups), [groups]);
  const filteredGroups = useMemo(
    () => groups.filter((group) => notificationGroupMatches(group, activeFilter, activeCategory)),
    [activeCategory, activeFilter, groups],
  );

  useEffect(() => {
    if (!open) {
      initializedForOpenRef.current = false;
      return;
    }
    closeButtonRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || loading || initializedForOpenRef.current) return;
    setActiveFilter(summary.actionUnread > 0 ? 'action' : summary.unread > 0 ? 'unread' : 'all');
    setActiveCategory('all');
    initializedForOpenRef.current = true;
  }, [loading, open, summary.actionUnread, summary.unread]);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

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
    if (unreadIds.length > 0) {
      await Promise.all(unreadIds.map((id) => markAsRead(id)));
    }
    if (group.primary.link) navigate(group.primary.link);
    onClose();
  }, [markAsRead, navigate, onClose]);

  const handleDismiss = useCallback((notificationId: string) => {
    void deleteNotification(notificationId);
  }, [deleteNotification]);

  const openInbox = useCallback(() => {
    navigate('/notifications');
    onClose();
  }, [navigate, onClose]);

  const filterCount = (filter: NotificationFilter) => {
    if (filter === 'action') return summary.action;
    if (filter === 'unread') return unreadCount;
    return summary.total;
  };
  const hasUnread = unreadCount > 0;
  const emptyTitle = activeFilter === 'action'
    ? 'No action required'
    : activeFilter === 'unread'
      ? 'You are caught up'
      : 'No notifications yet';
  const emptyDescription = activeCategory === 'all'
    ? activeFilter === 'action'
      ? 'Approvals, access requests, failures and overdue work will appear here.'
      : 'New activity will appear here when it arrives.'
    : `No ${NOTIFICATION_CATEGORY_LABELS[activeCategory].toLocaleLowerCase()} notifications match this view.`;

  if (!open) return null;

  return (
    <Portal>
      <div
        ref={containerRef}
        className={styles.overlay}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-center-title"
        tabIndex={-1}
        data-overlay-id={overlayId}
      >
        <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
        <section className={styles.panel}>
          <header className={styles.panelHeader}>
            <div>
              <h2 id="notification-center-title" className={styles.panelTitle}>Notifications</h2>
              <p className={styles.panelSubtitle}>{unreadCount} unread notification{unreadCount === 1 ? '' : 's'}</p>
            </div>
            <div className={styles.panelActions}>
              <button
                className={styles.markAllReadButton}
                onClick={() => void markAllAsRead()}
                disabled={!hasUnread || loading}
                type="button"
              >
                Mark all read
              </button>
              <button
                ref={closeButtonRef}
                className={styles.closeButton}
                onClick={onClose}
                type="button"
                aria-label="Close notifications"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </header>

          {summary.actionUnread > 0 ? (
            <button className={styles.actionSummary} type="button" onClick={() => setActiveFilter('action')}>
              <span className={styles.actionSummaryIcon} aria-hidden="true">!</span>
              <span>
                <strong>{summary.actionUnread} new item{summary.actionUnread === 1 ? '' : 's'} need your attention</strong>
                <small>Review approvals, access, failures and overdue work</small>
              </span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          ) : null}

          <div className={styles.filters}>
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
                  {tab.label}<span className={styles.tabCount}>{filterCount(tab.id)}</span>
                </button>
              ))}
            </div>
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

          <div className={styles.notificationList} role="list" aria-label="Notifications list">
            {loading ? (
              Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className={styles.skeletonItem} role="listitem">
                  <Skeleton variant="circle" width={36} height={36} />
                  <div className={styles.skeletonContent}>
                    <Skeleton variant="text" width="60%" />
                    <Skeleton variant="text" width="90%" />
                    <Skeleton variant="text" width="35%" />
                  </div>
                </div>
              ))
            ) : filteredGroups.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon} aria-hidden="true">
                  <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="m5 12 4 4L19 6" />
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                </div>
                <p className={styles.emptyTitle}>{emptyTitle}</p>
                <p className={styles.emptyDescription}>{emptyDescription}</p>
                {(activeFilter !== 'all' || activeCategory !== 'all') && summary.total > 0 ? (
                  <button
                    className={styles.showAllButton}
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
            ) : (
              <>
                {filteredGroups.map((group) => (
                  <NotificationItem
                    key={group.key}
                    group={group}
                    compact
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

          <footer className={styles.panelFooter}>
            <button type="button" onClick={openInbox}>Open notification inbox</button>
          </footer>
        </section>
      </div>
    </Portal>
  );
}
