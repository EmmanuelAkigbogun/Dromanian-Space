import { useMemo } from 'react';
import { EventCard } from '../EventCard/EventCard';
import type { CalendarEvent } from '@/types';
import styles from './MonthView.module.css';

interface MonthViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
  onDayClick: (date: Date) => void;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

const EVENT_COLORS = ['#82A6B1', '#2D8A4E', '#B8860B', '#C43E3E', '#4A7C9B', '#9B59B6'];

export function MonthView({ currentDate, events, onEventClick, onDayClick }: MonthViewProps) {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);

  const days = useMemo(() => {
    const result: Array<{ date: Date; isCurrentMonth: boolean; events: CalendarEvent[] }> = [];
    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    const daysInPrevMonth = getDaysInMonth(prevYear, prevMonth);

    for (let i = firstDay - 1; i >= 0; i--) {
      const date = new Date(prevYear, prevMonth, daysInPrevMonth - i);
      result.push({ date, isCurrentMonth: false, events: [] });
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      result.push({ date, isCurrentMonth: true, events: [] });
    }

    const remaining = 42 - result.length;
    const nextMonth = month === 11 ? 0 : month + 1;
    const nextYear = month === 11 ? year + 1 : year;
    for (let d = 1; d <= remaining; d++) {
      const date = new Date(nextYear, nextMonth, d);
      result.push({ date, isCurrentMonth: false, events: [] });
    }

    for (const day of result) {
      for (const event of events) {
        const eventStart = new Date(event.start_at);
        const eventEnd = new Date(event.end_at);
        if (day.date >= new Date(eventStart.getFullYear(), eventStart.getMonth(), eventStart.getDate()) &&
            day.date <= new Date(eventEnd.getFullYear(), eventEnd.getMonth(), eventEnd.getDate())) {
          day.events.push(event);
        }
      }
    }

    return result;
  }, [year, month, daysInMonth, firstDay, events]);

  return (
    <div className={styles.monthGrid}>
      <div className={styles.weekdayHeader}>
        {WEEKDAYS.map((day) => (
          <div key={day} className={styles.weekdayCell}>{day}</div>
        ))}
      </div>
      <div className={styles.daysGrid}>
        {days.map((day, index) => (
          <button
            key={index}
            type="button"
            className={`${styles.dayCell} ${!day.isCurrentMonth ? styles.otherMonth : ''} ${isToday(day.date) ? styles.today : ''}`}
            onClick={() => onDayClick(day.date)}
          >
            <span className={styles.dateNumber}>{day.date.getDate()}</span>
            <div className={styles.eventsContainer}>
              {day.events.slice(0, 3).map((event) => (
                <div
                  key={event.id}
                  className={styles.eventDot}
                  style={{ backgroundColor: event.color || EVENT_COLORS[0] }}
                  onClick={(e) => { e.stopPropagation(); onEventClick(event); }}
                  title={event.title}
                >
                  <span className={styles.eventTitle}>{event.title}</span>
                </div>
              ))}
              {day.events.length > 3 && (
                <span className={styles.moreEvents}>+{day.events.length - 3}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
