import { useMemo } from 'react';
import type { CalendarEvent } from '@/types';
import { TimeGrid, type Anchor, type CalendarDraft } from '../TimeGrid/TimeGrid';
import { addDays, startOfDay } from '../calendarUtils';

interface WeekViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  draft: CalendarDraft | null;
  onEventClick: (event: CalendarEvent) => void;
  onDayClick: (date: Date) => void;
  onCreate: (draft: CalendarDraft, anchor: Anchor) => void;
  onChangeEvent: (event: CalendarEvent, start: Date, end: Date) => void;
}

export function WeekView({ currentDate, events, draft, onEventClick, onDayClick, onCreate, onChangeEvent }: WeekViewProps) {
  const days = useMemo(() => {
    const weekStart = addDays(startOfDay(currentDate), -currentDate.getDay());
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  }, [currentDate]);

  return (
    <TimeGrid
      days={days}
      events={events}
      draft={draft}
      onEventClick={onEventClick}
      onCreate={onCreate}
      onChangeEvent={onChangeEvent}
      onDayClick={onDayClick}
    />
  );
}
