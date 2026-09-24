import { useMemo } from 'react';
import type { CalendarEvent } from '@/types';
import styles from './AgendaView.module.css';

interface AgendaViewProps {
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
}

const EVENT_COLORS = ['#82A6B1', '#2D8A4E', '#B8860B', '#C43E3E', '#4A7C9B', '#9B59B6'];

function formatDate(date: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const cmp = new Date(date);
  cmp.setHours(0, 0, 0, 0);

  if (cmp.getTime() === today.getTime()) return 'Today';
  if (cmp.getTime() === tomorrow.getTime()) return 'Tomorrow';
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

interface GroupedEvents {
  date: Date;
  label: string;
  events: CalendarEvent[];
}

export function AgendaView({ events, onEventClick }: AgendaViewProps) {
  const groupedEvents = useMemo<GroupedEvents[]>(() => {
    const grouped = new Map<string, CalendarEvent[]>();

    for (const event of events) {
      const date = new Date(event.start_at);
      if (isNaN(date.getTime())) continue;
      const eventDate = new Date(date);
      eventDate.setHours(0, 0, 0, 0);
      const todayDate = new Date();
      todayDate.setHours(0, 0, 0, 0);
      if (eventDate.getTime() < todayDate.getTime()) continue;
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(event);
    }

    const result: GroupedEvents[] = [];
    const sortedKeys = Array.from(grouped.keys()).sort((a, b) => {
      const [aYear, aMonth, aDay] = a.split('-').map(Number);
      const [bYear, bMonth, bDay] = b.split('-').map(Number);
      return new Date(aYear, aMonth, aDay).getTime() - new Date(bYear, bMonth, bDay).getTime();
    });

    for (const key of sortedKeys) {
      const [year, month, day] = key.split('-').map(Number);
      const date = new Date(year, month, day);
      const eventsForDay = grouped.get(key)!;
      eventsForDay.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
      result.push({
        date,
        label: formatDate(date),
        events: eventsForDay,
      });
    }

    return result;
  }, [events]);

  if (events.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        </div>
        <h3 className={styles.emptyTitle}>No upcoming events</h3>
        <p className={styles.emptyDescription}>
          Your agenda is clear. Create an event to get started.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.agenda}>
      {groupedEvents.map((group) => {
        const now = Date.now();
        const allEnded = group.events.every((e) => new Date(e.end_at).getTime() < now);
        return (
          <div key={group.date.toISOString()} className={styles.dateGroup}>
            <div className={`${styles.dateHeader} ${allEnded ? styles.overdueHeader : ''}`}>
              <span className={styles.dateLabel}>{group.label}</span>
              <span className={styles.eventCount}>
                {group.events.length} event{group.events.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className={styles.eventsList}>
              {group.events.map((event) => {
                const ended = new Date(event.end_at).getTime() < now;
                return (
                  <button
                    key={event.id}
                    type="button"
                    className={`${styles.eventItem} ${ended ? styles.overdueItem : ''}`}
                    onClick={() => onEventClick(event)}
                  >
                    <div
                      className={styles.colorBar}
                      style={{ backgroundColor: event.color || EVENT_COLORS[0] }}
                    />
                    <div className={styles.eventContent}>
                      <div className={styles.eventTop}>
                        <span className={styles.eventTitle}>{event.title}</span>
                        <span className={styles.eventType}>
                          {event.all_day ? 'All Day' : new Date(event.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>
                      {event.description && (
                        <span className={styles.eventDescription}>{event.description}</span>
                      )}
                      {event.location && (
                        <span className={styles.eventLocation}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                            <circle cx="12" cy="10" r="3" />
                          </svg>
                          {event.location}
                        </span>
                      )}
                    </div>
                    {ended && <span className={styles.overdueBadge}>Overdue</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
