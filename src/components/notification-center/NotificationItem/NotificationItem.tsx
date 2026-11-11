import { formatRelativeTime } from '@/utils';
import type { NotificationGroup } from '@/features/notifications/presentation';
import styles from './NotificationItem.module.css';

interface NotificationItemProps {
  group: NotificationGroup;
  compact?: boolean;
  onOpen: (group: NotificationGroup) => void | Promise<void>;
  onDismiss: (notificationId: string) => void;
}

function NotificationGlyph({ priority }: { priority: NotificationGroup['presentation']['priority'] }) {
  if (priority === 'action') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
    );
  }

  if (priority === 'important') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
    );
  }

  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01M11 12h1v4h1" />
    </svg>
  );
}

export function NotificationItem({ group, compact = false, onOpen, onDismiss }: NotificationItemProps) {
  const { primary, presentation, count, unreadCount } = group;
  const itemLabel = [
    presentation.priorityLabel,
    unreadCount > 0 ? `${unreadCount} unread` : null,
    primary.title,
    primary.message,
    presentation.actionLabel,
  ].filter(Boolean).join('. ');

  return (
    <div
      className={`${styles.item} ${compact ? styles.compact : ''} ${unreadCount > 0 ? styles.unread : ''} ${styles[presentation.priority]}`}
      role="listitem"
    >
      <button
        className={styles.openButton}
        onClick={() => void onOpen(group)}
        type="button"
        aria-label={itemLabel}
      >
        <div className={styles.glyph} aria-hidden="true">
          <NotificationGlyph priority={presentation.priority} />
        </div>

        <div className={styles.content}>
          <div className={styles.titleRow}>
            <span className={styles.title}>{primary.title}</span>
            {count > 1 ? <span className={styles.repeatCount}>{count} updates</span> : null}
          </div>
          {primary.message ? <p className={styles.message}>{primary.message}</p> : null}
          <div className={styles.meta}>
            <span>{formatRelativeTime(primary.created_at)}</span>
            <span className={styles.category}>{presentation.categoryLabel}</span>
            {presentation.priorityLabel ? (
              <span className={styles.priorityLabel}>{presentation.priorityLabel}</span>
            ) : null}
            {presentation.actionLabel ? (
              <span className={styles.actionLabel}>
                {presentation.actionLabel}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </span>
            ) : null}
          </div>
        </div>
      </button>

      <button
        className={styles.dismissButton}
        onClick={() => {
          onDismiss(primary.id);
        }}
        type="button"
        aria-label={`${count > 1 ? 'Dismiss latest update' : 'Dismiss notification'}: ${primary.title}`}
        title={count > 1 ? 'Dismiss this update; earlier updates remain grouped' : 'Dismiss notification'}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
