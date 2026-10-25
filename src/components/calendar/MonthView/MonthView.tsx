import { useMemo, useRef, useState } from 'react';
import type { CalendarEvent } from '@/types';
import type { Anchor, CalendarDraft } from '../TimeGrid/TimeGrid';
import { DEFAULT_EVENT_COLOR, addDays, dayDiff, endOfDay, eventCoversDay, formatTime, isSameDay, isToday, startOfDay } from '../calendarUtils';
import styles from './MonthView.module.css';

interface MonthViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  draft: CalendarDraft | null;
  onEventClick: (event: CalendarEvent) => void;
  onDayClick: (date: Date) => void;
  onCreate: (draft: CalendarDraft, anchor: Anchor) => void;
  onChangeEvent: (event: CalendarEvent, start: Date, end: Date) => void;
}

const MAX_VISIBLE = 3;
const DRAG_THRESHOLD_PX = 4;

type Interaction =
  | { kind: 'select'; touch: boolean; x0: number; y0: number; moved: boolean; from: number; to: number }
  | { kind: 'move'; touch: boolean; x0: number; y0: number; moved: boolean; event: CalendarEvent; grab: number; target: number };

export function MonthView({ currentDate, events, draft, onEventClick, onDayClick, onCreate, onChangeEvent }: MonthViewProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);

  const days = useMemo(() => {
    const first = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    const gridStart = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [currentDate]);

  const weekdays = useMemo(() => days.slice(0, 7).map((d) => d.toLocaleDateString(undefined, { weekday: 'short' })), [days]);

  const update = (next: Interaction | null) => {
    interactionRef.current = next;
    setInteraction(next);
  };

  const indexAt = (clientX: number, clientY: number) => {
    const rect = gridRef.current!.getBoundingClientRect();
    const col = Math.min(Math.max(Math.floor(((clientX - rect.left) / rect.width) * 7), 0), 6);
    const row = Math.min(Math.max(Math.floor(((clientY - rect.top) / rect.height) * 6), 0), 5);
    return row * 7 + col;
  };

  const capture = (pointerId: number) => {
    try {
      gridRef.current?.setPointerCapture(pointerId);
    } catch {
      /* the pointer is already gone */
    }
  };

  const onCellDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const index = indexAt(e.clientX, e.clientY);
    capture(e.pointerId);
    update({ kind: 'select', touch: e.pointerType === 'touch', x0: e.clientX, y0: e.clientY, moved: false, from: index, to: index });
  };

  const onEventDown = (e: React.PointerEvent, event: CalendarEvent, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    capture(e.pointerId);
    update({ kind: 'move', touch: e.pointerType === 'touch', x0: e.clientX, y0: e.clientY, moved: false, event, grab: index, target: index });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const current = interactionRef.current;
    if (!current) return;
    const moved = current.moved || Math.hypot(e.clientX - current.x0, e.clientY - current.y0) > DRAG_THRESHOLD_PX;
    if (current.touch && moved) {
      update(null);
      return;
    }
    if (!moved) return;
    const index = indexAt(e.clientX, e.clientY);
    update(current.kind === 'select' ? { ...current, moved, to: index } : { ...current, moved, target: index });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const current = interactionRef.current;
    update(null);
    if (!current) return;
    if (current.kind === 'select') {
      const a = Math.min(current.from, current.to);
      const b = Math.max(current.from, current.to);
      onCreate({ start: startOfDay(days[a]), end: endOfDay(days[b]), allDay: true }, { x: e.clientX, y: e.clientY });
      return;
    }
    if (!current.moved) {
      onEventClick(current.event);
      return;
    }
    const shift = dayDiff(days[current.grab], days[current.target]);
    if (shift === 0) return;
    onChangeEvent(current.event, addDays(new Date(current.event.start_at), shift), addDays(new Date(current.event.end_at), shift));
  };

  // Days the pending selection, draft or dragged event will cover.
  const highlighted = useMemo(() => {
    const set = new Set<number>();
    if (interaction?.kind === 'select') {
      for (let i = Math.min(interaction.from, interaction.to); i <= Math.max(interaction.from, interaction.to); i++) set.add(i);
    } else if (interaction?.kind === 'move' && interaction.moved) {
      const shift = interaction.target - interaction.grab;
      days.forEach((day, i) => {
        if (eventCoversDay(interaction.event, addDays(day, -shift))) set.add(i);
      });
    } else if (draft) {
      days.forEach((day, i) => {
        if (day >= startOfDay(draft.start) && day <= draft.end) set.add(i);
      });
    }
    return set;
  }, [interaction, draft, days]);

  const eventsByDay = useMemo(
    () =>
      days.map((day) =>
        events
          .filter((e) => eventCoversDay(e, day))
          .sort((a, b) => Number(b.all_day) - Number(a.all_day) || new Date(a.start_at).getTime() - new Date(b.start_at).getTime()),
      ),
    [days, events],
  );

  return (
    <div className={styles.monthGrid}>
      <div className={styles.weekdayHeader}>
        {weekdays.map((name) => (
          <div key={name} className={styles.weekdayCell}>{name}</div>
        ))}
      </div>
      <div
        ref={gridRef}
        className={`${styles.daysGrid} ${interaction?.moved ? styles.dragging : ''}`}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => update(null)}
      >
        {days.map((day, index) => {
          const inMonth = day.getMonth() === currentDate.getMonth();
          const dayEvents = eventsByDay[index];
          const draftHere = draft && !interaction && highlighted.has(index) && isSameDay(day, startOfDay(draft.start));
          return (
            <div
              key={day.toISOString()}
              className={`${styles.dayCell} ${!inMonth ? styles.otherMonth : ''} ${highlighted.has(index) ? styles.highlighted : ''}`}
              onPointerDown={onCellDown}
            >
              <button
                type="button"
                className={`${styles.dateNumber} ${isToday(day) ? styles.todayNumber : ''}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onDayClick(day)}
                aria-label={`Open ${day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`}
              >
                {day.getDate() === 1 ? day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : day.getDate()}
              </button>
              <div className={styles.eventsContainer}>
                {draftHere && <span className={`${styles.eventBar} ${styles.draft}`}>(No title)</span>}
                {dayEvents.slice(0, MAX_VISIBLE).map((event) => {
                  const dragging = interaction?.kind === 'move' && interaction.moved && interaction.event.id === event.id;
                  const color = event.color || DEFAULT_EVENT_COLOR;
                  return event.all_day ? (
                    <div
                      key={event.id}
                      role="button"
                      tabIndex={0}
                      className={`${styles.eventBar} ${dragging ? styles.eventDragging : ''}`}
                      style={{ backgroundColor: color }}
                      onPointerDown={(e) => onEventDown(e, event, index)}
                      onKeyDown={(e) => e.key === 'Enter' && onEventClick(event)}
                      title={event.title}
                    >
                      {event.title}
                    </div>
                  ) : (
                    <div
                      key={event.id}
                      role="button"
                      tabIndex={0}
                      className={`${styles.eventTimed} ${dragging ? styles.eventDragging : ''}`}
                      onPointerDown={(e) => onEventDown(e, event, index)}
                      onKeyDown={(e) => e.key === 'Enter' && onEventClick(event)}
                      title={`${formatTime(new Date(event.start_at))} ${event.title}`}
                    >
                      <span className={styles.dot} style={{ backgroundColor: color }} />
                      <span className={styles.eventTime}>{formatTime(new Date(event.start_at))}</span>
                      <span className={styles.eventTitle}>{event.title}</span>
                    </div>
                  );
                })}
                {dayEvents.length > MAX_VISIBLE && (
                  <button
                    type="button"
                    className={styles.moreEvents}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onDayClick(day)}
                  >
                    {dayEvents.length - MAX_VISIBLE} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
