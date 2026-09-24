import { useState, useCallback, useMemo } from 'react';
import { MonthView } from '../MonthView/MonthView';
import { WeekView } from '../WeekView/WeekView';
import { DayView } from '../DayView/DayView';
import { AgendaView } from '../AgendaView/AgendaView';
import { EventDialog } from '../EventDialog/EventDialog';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog/ConfirmDialog';
import type { CalendarEvent, CalendarReminder, CalendarViewType } from '@/types';
import styles from './CalendarView.module.css';

interface CalendarViewProps {
  onEventClick?: (event: CalendarEvent) => void;
  events: CalendarEvent[];
  createEvent: (event: Omit<CalendarEvent, 'id' | 'created_at' | 'updated_at' | 'user_id'>) => Promise<CalendarEvent | null>;
  updateEvent: (id: string, updates: Partial<CalendarEvent>) => Promise<boolean>;
  deleteEvent: (id: string) => Promise<boolean>;
  isLoading: boolean;
  reminders: CalendarReminder[];
  createReminder: (reminder: Omit<CalendarReminder, 'id' | 'created_at' | 'user_id' | 'notified' | 'dismissed'>) => Promise<CalendarReminder | null>;
  onRemindersChanged: () => Promise<void>;
}

function getStartOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getEndOfWeek(date: Date): Date {
  const start = getStartOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

function getStartOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getEndOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function formatMonthYear(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function formatDayHeader(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

const VIEW_LABELS: Record<CalendarViewType, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  agenda: 'Agenda',
};

export function CalendarView({ onEventClick, events, createEvent, updateEvent, deleteEvent, isLoading, reminders, createReminder, onRemindersChanged }: CalendarViewProps) {
  const [currentView, setCurrentView] = useState<CalendarViewType>('month');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [showEventDialog, setShowEventDialog] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const navigate = useCallback((direction: 'prev' | 'next') => {
    setCurrentDate((prev) => {
      const d = new Date(prev);
      if (currentView === 'day') d.setDate(d.getDate() + (direction === 'next' ? 1 : -1));
      else if (currentView === 'week') d.setDate(d.getDate() + (direction === 'next' ? 7 : -7));
      else if (currentView === 'month') d.setMonth(d.getMonth() + (direction === 'next' ? 1 : -1));
      else d.setDate(d.getDate() + (direction === 'next' ? 7 : -7));
      return d;
    });
  }, [currentView]);

  const goToToday = useCallback(() => setCurrentDate(new Date()), []);

  const rangeLabel = useMemo(() => {
    if (currentView === 'day') return formatDayHeader(currentDate);
    if (currentView === 'week') {
      const start = getStartOfWeek(currentDate);
      const end = getEndOfWeek(currentDate);
      return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    return formatMonthYear(currentDate);
  }, [currentDate, currentView]);

  const range = useMemo(() => {
    if (currentView === 'month') return { start: getStartOfMonth(currentDate), end: getEndOfMonth(currentDate) };
    if (currentView === 'week') return { start: getStartOfWeek(currentDate), end: getEndOfWeek(currentDate) };
    const start = new Date(currentDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(currentDate);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }, [currentDate, currentView]);

  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      const eventStart = new Date(e.start_at);
      const eventEnd = new Date(e.end_at);
      return eventEnd >= range.start && eventStart <= range.end;
    });
  }, [events, range]);

  const handleEventClick = useCallback((event: CalendarEvent) => {
    setSelectedEvent(event);
    setShowEventDialog(true);
    onEventClick?.(event);
  }, [onEventClick]);

  const handleCreateEvent = useCallback(() => {
    setSelectedEvent(null);
    setShowEventDialog(true);
  }, []);

  const handleSaveEvent = useCallback(async (eventData: Omit<CalendarEvent, 'id' | 'created_at' | 'updated_at' | 'created_by'>) => {
    let saved: CalendarEvent | null = null;
    if (selectedEvent) {
      const ok = await updateEvent(selectedEvent.id, eventData);
      saved = ok ? selectedEvent : null;
    } else {
      saved = await createEvent(eventData);
    }
    setShowEventDialog(false);
    setSelectedEvent(null);
    return saved;
  }, [selectedEvent, createEvent, updateEvent]);

  const handleDeleteEvent = useCallback(async () => {
    if (selectedEvent) {
      await deleteEvent(selectedEvent.id);
      setShowEventDialog(false);
      setSelectedEvent(null);
      setConfirmDelete(false);
    }
  }, [selectedEvent, deleteEvent]);

  const handleDayClick = useCallback((date: Date) => {
    setCurrentDate(date);
    setCurrentView('day');
  }, []);

  if (isLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading calendar...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <button type="button" className={styles.todayButton} onClick={goToToday}>
            Today
          </button>
          <button type="button" className={styles.navButton} onClick={() => navigate('prev')} aria-label="Previous">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button type="button" className={styles.navButton} onClick={() => navigate('next')} aria-label="Next">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <span className={styles.rangeLabel}>{rangeLabel}</span>
        </div>
        <div className={styles.toolbarRight}>
          <div className={styles.viewSwitcher}>
            {(Object.keys(VIEW_LABELS) as CalendarViewType[]).map((view) => (
              <button
                key={view}
                type="button"
                className={`${styles.viewButton} ${currentView === view ? styles.viewButtonActive : ''}`}
                onClick={() => setCurrentView(view)}
              >
                {VIEW_LABELS[view]}
              </button>
            ))}
          </div>
          <button type="button" className={styles.createButton} onClick={handleCreateEvent}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Event
          </button>
        </div>
      </div>

      <div className={styles.viewContainer}>
        {currentView === 'month' && (
          <MonthView
            currentDate={currentDate}
            events={filteredEvents}
            onEventClick={handleEventClick}
            onDayClick={handleDayClick}
          />
        )}
        {currentView === 'week' && (
          <WeekView
            currentDate={currentDate}
            events={filteredEvents}
            onEventClick={handleEventClick}
            onDayClick={handleDayClick}
          />
        )}
        {currentView === 'day' && (
          <DayView
            currentDate={currentDate}
            events={filteredEvents}
            onEventClick={handleEventClick}
          />
        )}
        {currentView === 'agenda' && (
          <AgendaView
            events={events}
            onEventClick={handleEventClick}
          />
        )}
      </div>

      {showEventDialog && (
        <EventDialog
          event={selectedEvent}
          existingReminder={selectedEvent ? reminders.find((r) => r.entity_type === 'event' && r.entity_id === selectedEvent.id) || null : null}
          onSave={handleSaveEvent}
          onDelete={selectedEvent ? async () => { setShowEventDialog(false); setConfirmDelete(true); } : undefined}
          onClose={() => { setShowEventDialog(false); setSelectedEvent(null); }}
          createReminder={createReminder}
          onRemindersChanged={onRemindersChanged}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete event"
        message="Are you sure you want to delete this event? This action cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={handleDeleteEvent}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
