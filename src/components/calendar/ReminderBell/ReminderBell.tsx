import { useState, useEffect } from 'react';
import { Badge } from '@/components/ui/Badge/Badge';
import { ScrollArea } from '@/components/ui/ScrollArea/ScrollArea';
import { formatRelativeTime } from '@/utils';
import type { CalendarReminder } from '@/types';
import styles from './ReminderBell.module.css';

interface ReminderBellProps {
  reminders: CalendarReminder[];
  onDismiss?: (id: string) => void;
  onSnooze?: (id: string, minutes: number) => void;
  onComplete?: (id: string) => void;
}

export function ReminderBell({ reminders, onDismiss, onSnooze, onComplete }: ReminderBellProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [snoozeMenuFor, setSnoozeMenuFor] = useState<string | null>(null);

  const now = new Date();
  const pendingReminders = reminders.filter(
    (r) => !r.completed && !r.dismissed && new Date(r.remind_at) <= now,
  );
  const hasReminders = pendingReminders.length > 0;

  const close = () => {
    setIsOpen(false);
    setSnoozeMenuFor(null);
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  return (
    <>
      <div className={styles.container}>
        <button
          type="button"
          className={`${styles.bellButton} ${hasReminders ? styles.hasReminders : ''}`}
          onClick={() => setIsOpen(!isOpen)}
          aria-label={`Reminders (${pendingReminders.length})`}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          {hasReminders && (
            <Badge variant="error" size="sm" className={styles.countBadge}>
              {pendingReminders.length}
            </Badge>
          )}
        </button>
      </div>

      {isOpen && (
        <div className={styles.overlay}>
          <div className={styles.backdrop} onClick={close} aria-hidden="true" />
          <div className={styles.panel} role="dialog" aria-modal="true" aria-label="Reminders">
            <div className={styles.panelHeader}>
              <span className={styles.panelTitle}>Reminders</span>
              <div className={styles.panelHeaderRight}>
                {hasReminders && (
                  <span className={styles.pendingCount}>{pendingReminders.length} pending</span>
                )}
                <button
                  type="button"
                  className={styles.closeButton}
                  onClick={close}
                  aria-label="Close reminders"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <ScrollArea className={styles.panelContent}>
              {pendingReminders.length === 0 ? (
                <div className={styles.empty}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={styles.emptyIcon}>
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                  <span className={styles.emptyText}>No pending reminders</span>
                </div>
              ) : (
                pendingReminders.map((reminder) => (
                  <div key={reminder.id} className={styles.reminderItem}>
                    <div className={styles.reminderContent}>
                      <span className={styles.reminderTitle}>{reminder.title}</span>
                      {reminder.message && (
                        <span className={styles.reminderMessage}>{reminder.message}</span>
                      )}
                      <span className={styles.reminderTime}>
                        {formatRelativeTime(reminder.remind_at)}
                      </span>
                    </div>
                    <div className={styles.reminderActions}>
                      {onComplete && (
                        <button
                          type="button"
                          className={styles.actionButton}
                          onClick={() => onComplete(reminder.id)}
                          title="Complete"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </button>
                      )}
                      <div className={styles.snoozeWrapper}>
                        <button
                          type="button"
                          className={styles.actionButton}
                          onClick={() => setSnoozeMenuFor(snoozeMenuFor === reminder.id ? null : reminder.id)}
                          title="Snooze"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                          </svg>
                        </button>
                        {snoozeMenuFor === reminder.id && onSnooze && (
                          <div className={styles.snoozeMenu}>
                            <button type="button" className={styles.snoozeOption} onClick={() => { onSnooze(reminder.id, 5); setSnoozeMenuFor(null); }}>
                              5 minutes
                            </button>
                            <button type="button" className={styles.snoozeOption} onClick={() => { onSnooze(reminder.id, 15); setSnoozeMenuFor(null); }}>
                              15 minutes
                            </button>
                            <button type="button" className={styles.snoozeOption} onClick={() => { onSnooze(reminder.id, 60); setSnoozeMenuFor(null); }}>
                              1 hour
                            </button>
                            <button type="button" className={styles.snoozeOption} onClick={() => { onSnooze(reminder.id, 1440); setSnoozeMenuFor(null); }}>
                              Tomorrow
                            </button>
                          </div>
                        )}
                      </div>
                      {onDismiss && (
                        <button
                          type="button"
                          className={styles.actionButton}
                          onClick={() => onDismiss(reminder.id)}
                          title="Dismiss"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </ScrollArea>
          </div>
        </div>
      )}
    </>
  );
}
