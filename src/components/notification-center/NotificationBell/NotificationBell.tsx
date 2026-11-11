import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useNotifications } from '@/hooks/useNotifications';
import { groupNotifications, summarizeNotificationGroups } from '@/features/notifications/presentation';
import { NotificationCenter } from '../NotificationCenter/NotificationCenter';
import styles from './NotificationBell.module.css';

export function NotificationBell() {
  const { unreadCount, notifications } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);
  const previousUnreadCountRef = useRef(unreadCount);
  const actionUnread = useMemo(
    () => summarizeNotificationGroups(groupNotifications(notifications)).actionUnread,
    [notifications],
  );

  useEffect(() => {
    if (unreadCount > previousUnreadCountRef.current) {
      setPulse(true);
      const timer = window.setTimeout(() => setPulse(false), 600);
      previousUnreadCountRef.current = unreadCount;
      return () => clearTimeout(timer);
    }
    previousUnreadCountRef.current = unreadCount;
  }, [unreadCount]);

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    bellRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, handleClose]);

  const displayCount = unreadCount > 99 ? '99+' : unreadCount;

  return (
    <>
      <button
        ref={bellRef}
        className={`${styles.bellButton} ${unreadCount > 0 ? styles.bellButtonHasUnread : ''} ${actionUnread > 0 ? styles.bellButtonAction : ''}`}
        onClick={handleToggle}
        type="button"
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}${actionUnread > 0 ? `, ${actionUnread} requiring action` : ''}`}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
      >
        <svg
          className={styles.bellIcon}
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className={`${styles.badge} ${actionUnread > 0 ? styles.badgeAction : ''} ${pulse ? styles.badgePulse : ''}`}>
            {displayCount}
          </span>
        )}
      </button>
      <NotificationCenter open={isOpen} onClose={handleClose} />
    </>
  );
}
