import { useMemo } from 'react';
import type { CalendarEvent } from '@/types';
import styles from './DayView.module.css';

interface DayViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

const EVENT_COLORS = ['#82A6B1', '#2D8A4E', '#B8860B', '#C43E3E', '#4A7C9B', '#9B59B6'];

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

export function DayView({ currentDate, events, onEventClick }: DayViewProps) {
  const allDayEvents = useMemo(() => events.filter((e) => e.all_day), [events]);
  const timedEvents = useMemo(() => events.filter((e) => !e.all_day), [events]);

  const getEventPosition = (event: CalendarEvent) => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    const dayStart = new Date(currentDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(currentDate);
    dayEnd.setHours(23, 59, 59, 999);

    const effectiveStart = start > dayStart ? start : dayStart;
    const effectiveEnd = end < dayEnd ? end : dayEnd;

    const startHour = effectiveStart.getHours() + effectiveStart.getMinutes() / 60;
    const endHour = effectiveEnd.getHours() + effectiveEnd.getMinutes() / 60;
    const duration = Math.max(endHour - startHour, 0.5);

    return {
      top: `${startHour * 60}px`,
      height: `${duration * 60}px`,
    };
  };

  const nowIndicator = useMemo(() => {
    if (!isToday(currentDate)) return null;
    const now = new Date();
    return `${(now.getHours() + now.getMinutes() / 60) * 60}px`;
  }, [currentDate]);

  const dayLabel = currentDate.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className={styles.dayView}>
      <div className={styles.dayHeader}>
        <span className={`${styles.dayTitle} ${isToday(currentDate) ? styles.todayTitle : ''}`}>
          {dayLabel}
        </span>
        {isToday(currentDate) && <span className={styles.todayBadge}>Today</span>}
      </div>

      {allDayEvents.length > 0 && (
        <div className={styles.allDaySection}>
          <span className={styles.allDayLabel}>All Day</span>
          <div className={styles.allDayEvents}>
            {allDayEvents.map((event) => (
              <button
                key={event.id}
                type="button"
                className={styles.allDayEvent}
                style={{ backgroundColor: event.color || EVENT_COLORS[0] }}
                onClick={() => onEventClick(event)}
              >
                {event.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={styles.timeGridContainer}>
        <div className={styles.timeColumn}>
          {HOURS.map((hour) => (
            <div key={hour} className={styles.timeLabel}>
              {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
            </div>
          ))}
        </div>
        <div className={styles.eventsColumn}>
          {HOURS.map((hour) => (
            <div key={hour} className={styles.hourCell}>
              <div className={styles.halfHourLine} />
            </div>
          ))}
          {timedEvents.map((event) => {
            const pos = getEventPosition(event);
            return (
              <button
                key={event.id}
                type="button"
                className={styles.eventBlock}
                style={{
                  top: pos.top,
                  height: pos.height,
                  backgroundColor: event.color || EVENT_COLORS[0],
                }}
                onClick={() => onEventClick(event)}
              >
                <span className={styles.eventTime}>
                  {new Date(event.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  {' - '}
                  {new Date(event.end_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </span>
                <span className={styles.eventTitle}>{event.title}</span>
                {event.location && <span className={styles.eventLocation}>{event.location}</span>}
              </button>
            );
          })}
          {nowIndicator && <div className={styles.nowIndicator} style={{ top: nowIndicator }} />}
        </div>
      </div>
    </div>
  );
}
