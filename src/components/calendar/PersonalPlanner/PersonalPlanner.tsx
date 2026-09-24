import { ScrollArea } from '@/components/ui/ScrollArea/ScrollArea';
import { EventCard } from '../EventCard/EventCard';
import { Badge } from '@/components/ui/Badge/Badge';
import { formatRelativeTime } from '@/utils';
import type { CalendarEvent, CalendarReminder } from '@/types';
import styles from './PersonalPlanner.module.css';

interface PersonalPlannerProps {
  events: CalendarEvent[];
  reminders: CalendarReminder[];
  pendingReminders: CalendarReminder[];
  onEventClick?: (event: CalendarEvent) => void;
}

function isToday(date: Date): boolean {
  const today = new Date();
  return date.getFullYear() === today.getFullYear() &&
         date.getMonth() === today.getMonth() &&
         date.getDate() === today.getDate();
}

function isThisWeek(date: Date): boolean {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);
  return date >= startOfWeek && date <= endOfWeek;
}

function isPast(date: Date): boolean {
  return date < new Date();
}

export function PersonalPlanner({ events, reminders, pendingReminders, onEventClick }: PersonalPlannerProps) {
  const now = Date.now();
  const todayEvents = events.filter((e) => isToday(new Date(e.start_at)));
  const thisWeekEvents = events.filter((e) => {
    const date = new Date(e.start_at);
    return isThisWeek(date) && !isToday(date) && !isPast(date);
  });
  const upcomingEvents = events.filter((e) => {
    const date = new Date(e.start_at);
    return !isThisWeek(date) && !isPast(date);
  });

  const overdueReminders = pendingReminders.filter((r) => isPast(new Date(r.remind_at)));

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Personal Planner</span>
      </div>
      <ScrollArea className={styles.content}>
        {overdueReminders.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
                <span className={`${styles.sectionTitle} ${styles.overdueTitle}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  Reminders
                </span>
              <Badge variant="error" size="sm">{overdueReminders.length}</Badge>
            </div>
            {overdueReminders.map((reminder) => (
              <div key={reminder.id} className={styles.reminderItem}>
                <span className={styles.reminderTitle}>{reminder.title}</span>
                <span className={styles.reminderTime}>{formatRelativeTime(reminder.remind_at)}</span>
              </div>
            ))}
          </div>
        )}

        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Today
            </span>
            {todayEvents.length > 0 && (
              <Badge variant="primary" size="sm">{todayEvents.length}</Badge>
            )}
          </div>
          {todayEvents.length === 0 ? (
            <div className={styles.emptySection}>
              <span className={styles.emptyText}>No events today</span>
            </div>
          ) : (
            todayEvents.map((event) => (
              <EventCard key={event.id} event={event} compact onClick={onEventClick} isOverdue={new Date(event.end_at).getTime() < now} />
            ))
          )}
        </div>

        {thisWeekEvents.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
                This Week
              </span>
              <Badge variant="info" size="sm">{thisWeekEvents.length}</Badge>
            </div>
            {thisWeekEvents.map((event) => (
              <EventCard key={event.id} event={event} compact onClick={onEventClick} isOverdue={new Date(event.end_at).getTime() < now} />
            ))}
          </div>
        )}

        {upcomingEvents.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
                  <polyline points="17 6 23 6 23 12" />
                </svg>
                Upcoming
              </span>
              <Badge variant="default" size="sm">{upcomingEvents.length}</Badge>
            </div>
            {upcomingEvents.slice(0, 5).map((event) => (
              <EventCard key={event.id} event={event} compact onClick={onEventClick} />
            ))}
            {upcomingEvents.length > 5 && (
              <span className={styles.moreText}>+{upcomingEvents.length - 5} more events</span>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
