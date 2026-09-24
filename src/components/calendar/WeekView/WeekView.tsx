import { useMemo } from 'react';
import type { CalendarEvent } from '@/types';
import styles from './WeekView.module.css';

interface WeekViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
  onDayClick: (date: Date) => void;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function getStartOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const EVENT_COLORS = ['#82A6B1', '#2D8A4E', '#B8860B', '#C43E3E', '#4A7C9B', '#9B59B6'];

export function WeekView({ currentDate, events, onEventClick, onDayClick }: WeekViewProps) {
  const weekStart = useMemo(() => getStartOfWeek(currentDate), [currentDate]);

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(weekStart);
      date.setDate(date.getDate() + i);
      return date;
    });
  }, [weekStart]);

  const multiDayEvents = useMemo(() => {
    return events.filter((e) => {
      const start = new Date(e.start_at);
      const end = new Date(e.end_at);
      const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      return startDay.getTime() !== endDay.getTime();
    });
  }, [events]);

  const timedEvents = useMemo(() => {
    return events.filter((e) => !e.all_day);
  }, [events]);

  const allDayEvents = useMemo(() => {
    return events.filter((e) => e.all_day);
  }, [events]);

  const getEventPosition = (event: CalendarEvent, dayIndex: number) => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    const dayDate = weekDays[dayIndex];
    const dayStart = new Date(dayDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayDate);
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

  const getEventsForDay = (dayIndex: number) => {
    const dayDate = weekDays[dayIndex];
    return timedEvents.filter((e) => {
      const start = new Date(e.start_at);
      const end = new Date(e.end_at);
      const dayStart = new Date(dayDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayDate);
      dayEnd.setHours(23, 59, 59, 999);
      return start <= dayEnd && end >= dayStart;
    });
  };

  const nowIndicator = useMemo(() => {
    const now = new Date();
    const todayIndex = weekDays.findIndex((d) => isToday(d));
    if (todayIndex === -1) return null;
    const hours = now.getHours() + now.getMinutes() / 60;
    return { top: `${hours * 60}px`, dayIndex: todayIndex };
  }, [weekDays]);

  return (
    <div className={styles.weekView}>
      {(multiDayEvents.length > 0 || allDayEvents.length > 0) && (
        <div className={styles.allDaySection}>
          <div className={styles.allDayLabel}>All Day</div>
          <div className={styles.allDayGrid}>
            {weekDays.map((day, dayIndex) => {
              const dayAllDay = allDayEvents.filter((e) => {
                const start = new Date(e.start_at);
                const end = new Date(e.end_at);
                return day >= new Date(start.getFullYear(), start.getMonth(), start.getDate()) &&
                       day <= new Date(end.getFullYear(), end.getMonth(), end.getDate());
              });
              return (
                <div key={dayIndex} className={styles.allDayCell}>
                  {dayAllDay.map((event) => (
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
              );
            })}
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
        <div className={styles.dayColumns}>
          {weekDays.map((day, dayIndex) => (
            <div key={dayIndex} className={styles.dayColumn}>
              <button
                type="button"
                className={`${styles.dayHeader} ${isToday(day) ? styles.todayHeader : ''}`}
                onClick={() => onDayClick(day)}
              >
                <span className={styles.dayName}>{DAY_LABELS[dayIndex]}</span>
                <span className={`${styles.dayNumber} ${isToday(day) ? styles.todayNumber : ''}`}>
                  {day.getDate()}
                </span>
              </button>
              <div className={styles.hourGrid}>
                {HOURS.map((hour) => (
                  <div key={hour} className={styles.hourCell} />
                ))}
                {getEventsForDay(dayIndex).map((event) => {
                  const pos = getEventPosition(event, dayIndex);
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
                      </span>
                      <span className={styles.eventTitle}>{event.title}</span>
                    </button>
                  );
                })}
                {isToday(day) && nowIndicator && (
                  <div className={styles.nowIndicator} style={{ top: nowIndicator.top }} />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
