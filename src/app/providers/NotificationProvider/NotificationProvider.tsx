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

  const fetchNotifications = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    const [notifs, count] = await Promise.all([
      getNotificationsPaginated(userId, { limit: 20, offset: 0 }),
      getNotificationUnreadCount(userId),
    ]);
    const unique = dedupeById(notifs);
    unique.forEach((n) => seenNotificationIdsRef.current.add(n.id));
    setNotifications(unique);
    setUnreadCount(count);
    setHasMore(notifs.length >= 20);
    setLoading(false);
  }, [userId]);

  const loadMore = useCallback(async () => {
    if (!userId || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const more = await getNotificationsPaginated(userId, {
      limit: 20,
      offset: notifications.length,
    });
    more.forEach((n) => seenNotificationIdsRef.current.add(n.id));
    if (more.length < 20) setHasMore(false);
    setNotifications((prev) => dedupeById([...prev, ...more]));
    setLoadingMore(false);
  }, [userId, notifications.length, loadingMore, hasMore]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  useEffect(() => {
    if (!userId) return;
    const unsubscribe = subscribeToNotifications(userId, (notification) => {
      if (isWithinQuietHours(quietHours.start, quietHours.end)) return;
      if (seenNotificationIdsRef.current.has(notification.id)) return;
      seenNotificationIdsRef.current.add(notification.id);
      setNotifications((prev) => [notification, ...prev]);
      setUnreadCount((prev) => prev + 1);
    });
    return unsubscribe;
  }, [userId, quietHours]);

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
    refresh: fetchNotifications,
  };

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}
