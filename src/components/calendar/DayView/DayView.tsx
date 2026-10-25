import { useMemo } from 'react';
import type { CalendarEvent } from '@/types';
import { TimeGrid, type Anchor, type CalendarDraft } from '../TimeGrid/TimeGrid';
import { startOfDay } from '../calendarUtils';

interface DayViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  draft: CalendarDraft | null;
  onEventClick: (event: CalendarEvent) => void;
  onCreate: (draft: CalendarDraft, anchor: Anchor) => void;
  onChangeEvent: (event: CalendarEvent, start: Date, end: Date) => void;
}

export function DayView({ currentDate, events, draft, onEventClick, onCreate, onChangeEvent }: DayViewProps) {
  const days = useMemo(() => [startOfDay(currentDate)], [currentDate]);
  return (
    <TimeGrid days={days} events={events} draft={draft} onEventClick={onEventClick} onCreate={onCreate} onChangeEvent={onChangeEvent} />
  );
}
