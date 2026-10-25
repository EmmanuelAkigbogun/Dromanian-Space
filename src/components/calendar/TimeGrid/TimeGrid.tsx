import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CalendarEvent } from '@/types';
import {
  DEFAULT_EVENT_COLOR,
  MINUTES_PER_DAY,
  addDays,
  addMinutes,
  endOfDay,
  eventCoversDay,
  formatHourLabel,
  formatTime,
  isToday,
  snap,
  startOfDay,
} from '../calendarUtils';
import styles from './TimeGrid.module.css';

export interface CalendarDraft {
  start: Date;
  end: Date;
  allDay: boolean;
}

export interface Anchor {
  x: number;
  y: number;
}

interface TimeGridProps {
  days: Date[];
  events: CalendarEvent[];
  /** The event being created (quick-create popover open). */
  draft: CalendarDraft | null;
  onEventClick: (event: CalendarEvent) => void;
  onCreate: (draft: CalendarDraft, anchor: Anchor) => void;
  onChangeEvent: (event: CalendarEvent, start: Date, end: Date) => void;
  onDayClick?: (day: Date) => void;
}

const HOUR_PX = 48;
const MIN_PX = HOUR_PX / 60;
const SNAP_MINUTES = 15;
const CLICK_DURATION = 60;
const DRAG_THRESHOLD_PX = 4;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

type Interaction =
  | { kind: 'create'; touch: boolean; x0: number; y0: number; moved: boolean; dayIndex: number; anchorMin: number; currentMin: number }
  | { kind: 'move'; touch: boolean; x0: number; y0: number; moved: boolean; event: CalendarEvent; offsetMin: number; duration: number; dayIndex: number; startMin: number; grabDay: number }
  | { kind: 'resize'; touch: boolean; x0: number; y0: number; moved: boolean; event: CalendarEvent; endAt: Date };

interface Segment {
  key: string;
  event: CalendarEvent | null;
  startMin: number;
  endMin: number;
  start: Date;
  end: Date;
  /** True when this segment is where the event really ends (resize handle). */
  isEnd: boolean;
  col: number;
  cols: number;
}

function clampMinutes(m: number): number {
  return Math.min(Math.max(m, 0), MINUTES_PER_DAY);
}

/** Clips an event to one day, in minutes from midnight. */
function segmentFor(day: Date, start: Date, end: Date): { startMin: number; endMin: number; isEnd: boolean } | null {
  const dayStart = startOfDay(day);
  const dayEnd = endOfDay(day);
  if (end <= dayStart || start > dayEnd) return null;
  const s = start < dayStart ? 0 : (start.getTime() - dayStart.getTime()) / 60_000;
  const e = end > dayEnd ? MINUTES_PER_DAY : (end.getTime() - dayStart.getTime()) / 60_000;
  return { startMin: s, endMin: Math.max(e, s + 15), isEnd: end <= dayEnd || end.getTime() === addDays(dayStart, 1).getTime() };
}

/** Places overlapping segments side by side, like Google Calendar. */
function layout(segments: Omit<Segment, 'col' | 'cols'>[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out: Segment[] = [];
  let cluster: Segment[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const s of cluster) s.cols = columnEnds.length;
    out.push(...cluster);
    cluster = [];
    columnEnds = [];
  };
  for (const seg of sorted) {
    if (seg.startMin >= clusterEnd && cluster.length) flush();
    let col = columnEnds.findIndex((end) => end <= seg.startMin);
    if (col === -1) {
      col = columnEnds.length;
      columnEnds.push(seg.endMin);
    } else {
      columnEnds[col] = seg.endMin;
    }
    const placed: Segment = { ...seg, col, cols: 1 };
    cluster.push(placed);
    clusterEnd = Math.max(clusterEnd, seg.endMin);
  }
  if (cluster.length) flush();
  return out;
}

export function TimeGrid({ days, events, draft, onEventClick, onCreate, onChangeEvent, onDayClick }: TimeGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Open scrolled to the working day, or to just before the current time.
  const firstDayKey = days[0]?.toDateString();
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const showsToday = days.some(isToday);
    const hour = showsToday ? Math.max(0, new Date().getHours() - 1.5) : 7.5;
    el.scrollTop = hour * HOUR_PX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstDayKey, days.length]);

  const update = (next: Interaction | null) => {
    interactionRef.current = next;
    setInteraction(next);
  };

  /** Pointer position as a day column and minutes from midnight. */
  const locate = (clientX: number, clientY: number) => {
    const rect = columnsRef.current!.getBoundingClientRect();
    const dayIndex = Math.min(Math.max(Math.floor(((clientX - rect.left) / rect.width) * days.length), 0), days.length - 1);
    const minutes = clampMinutes((clientY - rect.top) / MIN_PX);
    return { dayIndex, minutes };
  };

  const capture = (pointerId: number) => {
    try {
      columnsRef.current?.setPointerCapture(pointerId);
    } catch {
      /* the pointer is already gone */
    }
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { dayIndex, minutes } = locate(e.clientX, e.clientY);
    const anchorMin = Math.floor(minutes / SNAP_MINUTES) * SNAP_MINUTES;
    capture(e.pointerId);
    update({ kind: 'create', touch: e.pointerType === 'touch', x0: e.clientX, y0: e.clientY, moved: false, dayIndex, anchorMin, currentMin: anchorMin + SNAP_MINUTES });
  };

  const onEventDown = (e: React.PointerEvent, event: CalendarEvent, dayIndex: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const { minutes } = locate(e.clientX, e.clientY);
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    const startMin = (start.getTime() - startOfDay(days[dayIndex]).getTime()) / 60_000;
    capture(e.pointerId);
    update({
      kind: 'move',
      touch: e.pointerType === 'touch',
      x0: e.clientX,
      y0: e.clientY,
      moved: false,
      event,
      offsetMin: minutes - startMin,
      duration: (end.getTime() - start.getTime()) / 60_000,
      dayIndex,
      grabDay: dayIndex,
      startMin,
    });
  };

  const onResizeDown = (e: React.PointerEvent, event: CalendarEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    capture(e.pointerId);
    update({ kind: 'resize', touch: e.pointerType === 'touch', x0: e.clientX, y0: e.clientY, moved: false, event, endAt: new Date(event.end_at) });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const current = interactionRef.current;
    if (!current) return;
    const moved = current.moved || Math.hypot(e.clientX - current.x0, e.clientY - current.y0) > DRAG_THRESHOLD_PX;
    // On touch screens a drag is a scroll; only taps create or open.
    if (current.touch && moved) {
      update(null);
      return;
    }
    if (!moved) return;
    autoScroll(e.clientY);
    const { dayIndex, minutes } = locate(e.clientX, e.clientY);
    if (current.kind === 'create') {
      update({ ...current, moved, currentMin: snap(minutes, SNAP_MINUTES) });
    } else if (current.kind === 'move') {
      update({ ...current, moved, dayIndex, startMin: snap(minutes - current.offsetMin, SNAP_MINUTES) });
    } else {
      const dayStart = startOfDay(days[dayIndex]);
      const start = new Date(current.event.start_at);
      let endAt = addMinutes(dayStart, snap(minutes, SNAP_MINUTES));
      if (endAt.getTime() - start.getTime() < SNAP_MINUTES * 60_000) endAt = addMinutes(start, SNAP_MINUTES);
      update({ ...current, moved, endAt });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const current = interactionRef.current;
    update(null);
    if (!current) return;
    const anchor = { x: e.clientX, y: e.clientY };
    if (current.kind === 'create') {
      const dayStart = startOfDay(days[current.dayIndex]);
      let startMin: number;
      let endMin: number;
      if (!current.moved) {
        startMin = Math.floor(current.anchorMin / 30) * 30;
        endMin = Math.min(startMin + CLICK_DURATION, MINUTES_PER_DAY);
      } else {
        startMin = Math.min(current.anchorMin, current.currentMin);
        endMin = Math.max(current.anchorMin + SNAP_MINUTES, current.currentMin);
        if (current.currentMin < current.anchorMin) endMin = current.anchorMin + SNAP_MINUTES;
      }
      onCreate({ start: addMinutes(dayStart, startMin), end: addMinutes(dayStart, endMin), allDay: false }, anchor);
    } else if (current.kind === 'move') {
      if (!current.moved) {
        onEventClick(current.event);
        return;
      }
      const start = addMinutes(startOfDay(days[current.dayIndex]), current.startMin);
      if (start.getTime() !== new Date(current.event.start_at).getTime()) {
        onChangeEvent(current.event, start, addMinutes(start, current.duration));
      }
    } else if (current.moved) {
      onChangeEvent(current.event, new Date(current.event.start_at), current.endAt);
    }
  };

  const autoScroll = (clientY: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (clientY < rect.top + 120) el.scrollTop -= 12;
    else if (clientY > rect.bottom - 40) el.scrollTop += 12;
  };

  // Events as they should be drawn, with the one being dragged at its preview position.
  const preview = useMemo(() => {
    if (!interaction || !interaction.moved) return null;
    if (interaction.kind === 'move') {
      const start = addMinutes(startOfDay(days[interaction.dayIndex]), interaction.startMin);
      return { id: interaction.event.id, start, end: addMinutes(start, interaction.duration) };
    }
    if (interaction.kind === 'resize') {
      return { id: interaction.event.id, start: new Date(interaction.event.start_at), end: interaction.endAt };
    }
    return null;
  }, [interaction, days]);

  const creating = useMemo<CalendarDraft | null>(() => {
    if (interaction?.kind !== 'create' || !interaction.moved) return null;
    const dayStart = startOfDay(days[interaction.dayIndex]);
    const a = interaction.anchorMin;
    const b = interaction.currentMin;
    const startMin = Math.min(a, b);
    const endMin = Math.max(a + SNAP_MINUTES, b, startMin + SNAP_MINUTES);
    return { start: addMinutes(dayStart, startMin), end: addMinutes(dayStart, endMin), allDay: false };
  }, [interaction, days]);

  const shownDraft = creating ?? (draft && !draft.allDay ? draft : null);

  const columns = useMemo(
    () =>
      days.map((day) => {
        const segments: Omit<Segment, 'col' | 'cols'>[] = [];
        for (const event of events) {
          if (event.all_day) continue;
          const start = preview?.id === event.id ? preview.start : new Date(event.start_at);
          const end = preview?.id === event.id ? preview.end : new Date(event.end_at);
          const seg = segmentFor(day, start, end);
          if (seg) segments.push({ key: event.id, event, start, end, ...seg });
        }
        if (shownDraft) {
          const seg = segmentFor(day, shownDraft.start, shownDraft.end);
          if (seg) segments.push({ key: 'draft', event: null, start: shownDraft.start, end: shownDraft.end, ...seg });
        }
        return layout(segments);
      }),
    [days, events, preview, shownDraft],
  );

  const allDayByDay = useMemo(
    () => days.map((day) => events.filter((e) => e.all_day && eventCoversDay(e, day))),
    [days, events],
  );
  const allDayDraft = draft?.allDay ? draft : null;

  const nowTop = (now.getHours() * 60 + now.getMinutes()) * MIN_PX;
  const gridTemplate = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };

  return (
    <div className={styles.timeGrid}>
      <div ref={scrollRef} className={styles.scroll}>
        <div className={styles.sticky}>
          <div className={styles.headerRow}>
            <div className={styles.gutter} />
            <div className={styles.headerDays} style={gridTemplate}>
              {days.map((day) => (
                <button
                  key={day.toISOString()}
                  type="button"
                  className={`${styles.dayHeader} ${isToday(day) ? styles.dayHeaderToday : ''}`}
                  onClick={() => onDayClick?.(day)}
                  disabled={!onDayClick}
                >
                  <span className={styles.dayName}>{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                  <span className={styles.dayNumber}>{day.getDate()}</span>
                </button>
              ))}
            </div>
          </div>
          <div className={styles.allDayRow}>
            <div className={`${styles.gutter} ${styles.allDayLabel}`}>All day</div>
            <div className={styles.allDayCells} style={gridTemplate}>
              {days.map((day, i) => (
                <div
                  key={day.toISOString()}
                  className={styles.allDayCell}
                  onClick={(e) => {
                    if (e.target !== e.currentTarget) return;
                    onCreate({ start: startOfDay(day), end: endOfDay(day), allDay: true }, { x: e.clientX, y: e.clientY });
                  }}
                  title="Click to add an all-day event"
                >
                  {allDayByDay[i].map((event) => (
                    <button
                      key={event.id}
                      type="button"
                      className={styles.allDayEvent}
                      style={{ backgroundColor: event.color || DEFAULT_EVENT_COLOR }}
                      onClick={() => onEventClick(event)}
                    >
                      {event.title}
                    </button>
                  ))}
                  {allDayDraft && eventCoversDay({ start_at: allDayDraft.start.toISOString(), end_at: allDayDraft.end.toISOString() }, day) && (
                    <span className={`${styles.allDayEvent} ${styles.draft}`}>(No title)</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.body} style={{ height: 24 * HOUR_PX }}>
          <div className={styles.gutter}>
            {HOURS.map((h) => (
              <div key={h} className={styles.hourLabel} style={{ top: h * HOUR_PX }}>
                {formatHourLabel(h)}
              </div>
            ))}
          </div>
          <div
            ref={columnsRef}
            className={`${styles.columns} ${interaction?.moved ? styles.dragging : ''}`}
            style={gridTemplate}
            onPointerDown={onBackgroundDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => update(null)}
          >
            {days.map((day, dayIndex) => (
              <div key={day.toISOString()} className={styles.column}>
                {HOURS.map((h) => (
                  <div key={h} className={styles.hourLine} style={{ top: h * HOUR_PX }} />
                ))}
                {columns[dayIndex].map((seg) => {
                  const height = Math.max((seg.endMin - seg.startMin) * MIN_PX - 2, 18);
                  const style = {
                    top: seg.startMin * MIN_PX,
                    height,
                    left: `calc(${(seg.col / seg.cols) * 100}% + 2px)`,
                    width: `calc(${(1 / seg.cols) * 100}% - 4px)`,
                  };
                  const compact = height < 34;
                  const time = `${formatTime(seg.start)} – ${formatTime(seg.end)}`;
                  if (!seg.event) {
                    return (
                      <div key="draft" className={`${styles.event} ${styles.draft}`} style={style}>
                        <span className={styles.eventTitle}>(No title)</span>
                        {!compact && <span className={styles.eventTime}>{time}</span>}
                      </div>
                    );
                  }
                  const event = seg.event;
                  const active = preview?.id === event.id;
                  return (
                    <div
                      key={seg.key}
                      role="button"
                      tabIndex={0}
                      aria-label={`${event.title}, ${time}`}
                      className={`${styles.event} ${active ? styles.eventActive : ''} ${compact ? styles.eventCompact : ''}`}
                      style={{ ...style, backgroundColor: event.color || DEFAULT_EVENT_COLOR }}
                      onPointerDown={(e) => onEventDown(e, event, dayIndex)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onEventClick(event);
                        }
                      }}
                    >
                      <span className={styles.eventTitle}>{event.title}</span>
                      <span className={styles.eventTime}>{compact ? formatTime(seg.start) : time}</span>
                      {!compact && event.location && <span className={styles.eventTime}>{event.location}</span>}
                      {seg.isEnd && <span className={styles.resizeHandle} onPointerDown={(e) => onResizeDown(e, event)} aria-hidden="true" />}
                    </div>
                  );
                })}
                {isToday(day) && (
                  <div className={styles.nowLine} style={{ top: nowTop }} aria-hidden="true" />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
