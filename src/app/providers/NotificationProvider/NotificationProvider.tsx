import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { getWorkspaceSettings, isWithinQuietHours } from '@/lib/workspace/settings';
import {
  getNotificationsPaginated,
  getNotificationUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  subscribeToNotifications,
  deleteNotification,
} from '@/features/notifications/service';
import type { TypedNotification } from '@/features/notifications/service';
import { getNotificationPresentation } from '@/features/notifications/presentation';

interface NotificationContextValue {
  notifications: TypedNotification[];
  unreadCount: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  markAsRead: (id: string) => Promise<boolean>;
  markAllAsRead: () => Promise<boolean>;
  deleteNotification: (id: string) => Promise<boolean>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function useNotificationContext(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotificationContext must be used within NotificationProvider');
  return ctx;
}

function dedupeById(items: TypedNotification[]): TypedNotification[] {
  return Array.from(new Map(items.map((n) => [n.id, n])).values());
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const [notifications, setNotifications] = useState<TypedNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const seenNotificationIdsRef = useRef<Set<string>>(new Set());
  const loadingMoreRef = useRef(false);
  const loadMoreRequestRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const [quietHours, setQuietHours] = useState<{ start: string | null; end: string | null }>({
    start: null,
    end: null,
  });

  useEffect(() => {
    if (!currentWorkspace) return;
    getWorkspaceSettings(currentWorkspace.id).then((settings) => {
      setQuietHours({
        start: settings?.quiet_hours_start ?? null,
        end: settings?.quiet_hours_end ?? null,
      });
    });
  }, [currentWorkspace]);

  const cancelLoadMore = useCallback(() => {
    loadMoreRequestRef.current += 1;
    loadingMoreRef.current = false;
    setLoadingMore(false);
  }, []);

  const fetchNotifications = useCallback(async (options?: { silent?: boolean }) => {
    if (!userId) return;
    // A first-page reconciliation replaces the pagination base. Invalidate any
    // older page request so it cannot append results from a stale offset (or a
    // previous authenticated user) after the replacement finishes.
    cancelLoadMore();
    const requestId = ++refreshRequestRef.current;
    if (!options?.silent) setLoading(true);
    try {
      const [notifs, count] = await Promise.all([
        getNotificationsPaginated(userId, { limit: 20, offset: 0 }),
        getNotificationUnreadCount(userId),
      ]);
      if (requestId !== refreshRequestRef.current) return;
      if (notifs === null || count === null) return;
      cancelLoadMore();
      const unique = dedupeById(notifs);
      seenNotificationIdsRef.current = new Set(unique.map((notification) => notification.id));
      setNotifications(unique);
      setUnreadCount(count);
      setHasMore(notifs.length >= 20);
    } finally {
      if (requestId === refreshRequestRef.current) setLoading(false);
    }
  }, [cancelLoadMore, userId]);

  const loadMore = useCallback(async () => {
    if (!userId || loadingMoreRef.current || !hasMore) return;
    const requestId = ++loadMoreRequestRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const more = await getNotificationsPaginated(userId, {
        limit: 20,
        offset: notifications.length,
      });
      if (requestId !== loadMoreRequestRef.current) return;
      if (more === null) {
        // The intersection sentinel remains visible while a filtered page is
        // empty. Stop this pagination pass on a transient failure instead of
        // immediately hammering the endpoint; focus/online reconciliation
        // will restore hasMore after connectivity returns.
        setHasMore(false);
        return;
      }
      more.forEach((notification) => seenNotificationIdsRef.current.add(notification.id));
      if (more.length < 20) setHasMore(false);
      setNotifications((prev) => dedupeById([...prev, ...more]));
    } finally {
      if (requestId === loadMoreRequestRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [userId, notifications.length, hasMore]);

  useEffect(() => {
    if (!userId) {
      refreshRequestRef.current += 1;
      cancelLoadMore();
      seenNotificationIdsRef.current.clear();
      setNotifications([]);
      setUnreadCount(0);
      setHasMore(true);
      setLoading(false);
      return;
    }
    void fetchNotifications();
  }, [cancelLoadMore, fetchNotifications, userId]);

  // Mobile browsers suspend realtime sockets when the PWA is backgrounded.
  // Reconcile persisted notifications whenever the app becomes usable again,
  // so events received while asleep are not missing until a full reload.
  useEffect(() => {
    if (!userId) return;
    let lastRefreshAt = 0;
    const refreshAfterResume = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      const now = Date.now();
      if (now - lastRefreshAt < 1_000) return;
      lastRefreshAt = now;
      void fetchNotifications({ silent: true });
    };
    document.addEventListener('visibilitychange', refreshAfterResume);
    window.addEventListener('focus', refreshAfterResume);
    window.addEventListener('online', refreshAfterResume);
    return () => {
      document.removeEventListener('visibilitychange', refreshAfterResume);
      window.removeEventListener('focus', refreshAfterResume);
      window.removeEventListener('online', refreshAfterResume);
    };
  }, [fetchNotifications, userId]);

  useEffect(() => {
    if (!userId) return;
    const unsubscribe = subscribeToNotifications(userId, (notification) => {
      if (seenNotificationIdsRef.current.has(notification.id)) return;
      seenNotificationIdsRef.current.add(notification.id);
      setNotifications((prev) => [notification, ...prev]);
      if (!notification.read) setUnreadCount((prev) => prev + 1);
      // Quiet hours suppress disruptive desktop toasts, not the in-app inbox.
      // Keeping the persisted item visible prevents important work from being
      // silently missed until the next full refresh.
      if (isWithinQuietHours(quietHours.start, quietHours.end)) return;
      const presentation = getNotificationPresentation(notification);
      const shouldRaiseDesktopAlert = presentation.priority !== 'normal'
        || notification.type === 'message';
      if (!shouldRaiseDesktopAlert) return;
      // CallProvider raises the actionable incoming-call notification. Avoid a
      // second Windows toast from the accompanying persisted notification.
      if (!/^Incoming (voice|video) call$/i.test(notification.title)) {
        void window.darkspaceDesktop?.notify({
          title: notification.title,
          body: notification.message,
          route: notification.link ?? '/notifications',
          kind: ['message', 'mention', 'announcement'].includes(notification.type) ? 'message' : 'system',
        });
      }
    });
    return unsubscribe;
  }, [userId, quietHours]);

  useEffect(() => {
    window.darkspaceDesktop?.setUnreadCount(unreadCount);
  }, [unreadCount]);

  const handleMarkAsRead = useCallback(async (notificationId: string): Promise<boolean> => {
    const target = notifications.find((n) => n.id === notificationId);
    const wasUnread = target ? !target.read : true;
    const success = await markNotificationRead(notificationId);
    if (success) {
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, read: true } : n)),
      );
      if (wasUnread) {
        setUnreadCount((prev) => Math.max(0, prev - 1));
      }
    }
    return success;
  }, [notifications]);

  const handleMarkAllAsRead = useCallback(async (): Promise<boolean> => {
    if (!userId) return false;
    const success = await markAllNotificationsRead(userId);
    if (success) {
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    }
    return success;
  }, [userId]);

  const handleDelete = useCallback(async (notificationId: string): Promise<boolean> => {
    const success = await deleteNotification(notificationId);
    if (success) {
      const deleted = notifications.find((n) => n.id === notificationId);
      seenNotificationIdsRef.current.delete(notificationId);
      setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
      if (deleted && !deleted.read) {
        setUnreadCount((c) => Math.max(0, c - 1));
      }
    }
    return success;
  }, [notifications]);

  const value: NotificationContextValue = {
    notifications,
    unreadCount,
    loading,
    loadingMore,
    hasMore,
    markAsRead: handleMarkAsRead,
    markAllAsRead: handleMarkAllAsRead,
    deleteNotification: handleDelete,
    loadMore,
    refresh: () => fetchNotifications(),
  };

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}
