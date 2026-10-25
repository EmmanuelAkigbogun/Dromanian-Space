import type { CalendarEvent } from '@/types';

/** Event colors, all dark enough for white text. The first is the default. */
export const EVENT_COLORS = ['#5B5BD6', '#0B7FAB', '#2F8A5B', '#B7791F', '#D9541E', '#C93B3B', '#8E44AD', '#5F6B7A'];
export const DEFAULT_EVENT_COLOR = EVENT_COLORS[0];

export const MINUTES_PER_DAY = 24 * 60;

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

/** Whole days between the calendar dates of a and b (DST-safe). */
export function dayDiff(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86_400_000);
}

export function snap(minutes: number, step: number): number {
  return Math.round(minutes / step) * step;
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatHourLabel(hour: number): string {
  if (hour === 0) return '';
  const d = new Date(2000, 0, 1, hour);
  return d.toLocaleTimeString(undefined, { hour: 'numeric' });
}

/** "Thursday, 30 October · 10:00 – 11:00" (or "All day"). */
export function describeRange(start: Date, end: Date, allDay: boolean): string {
  const day = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  if (allDay) {
    return isSameDay(start, end) ? `${day(start)} · All day` : `${day(start)} – ${day(end)} · All day`;
  }
  return isSameDay(start, end)
    ? `${day(start)} · ${formatTime(start)} – ${formatTime(end)}`
    : `${day(start)} ${formatTime(start)} – ${day(end)} ${formatTime(end)}`;
}

/** The days an event touches, by calendar date. */
export function eventCoversDay(event: Pick<CalendarEvent, 'start_at' | 'end_at'>, day: Date): boolean {
  const start = new Date(event.start_at);
  const end = new Date(event.end_at);
  return start <= endOfDay(day) && end >= startOfDay(day) && !(end.getTime() === startOfDay(day).getTime() && end > start);
}
