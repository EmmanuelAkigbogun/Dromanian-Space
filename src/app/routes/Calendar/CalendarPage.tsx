import { CalendarView } from '@/components/calendar/CalendarView/CalendarView';
import { PersonalPlanner } from '@/components/calendar/PersonalPlanner/PersonalPlanner';
import { ScheduledMessages } from '@/components/calendar/ScheduledMessages/ScheduledMessages';
import { ReminderBell } from '@/components/calendar/ReminderBell/ReminderBell';
import { useCalendar } from '@/hooks/useCalendar';
import { platform } from '@/lib/platform';
import type { CalendarEvent } from '@/types';
import styles from './CalendarPage.module.css';

export function CalendarPage() {
  const {
    events,
    reminders,
    pendingReminders,
    scheduledMessages,
    createReminder,
    createEvent,
    updateEvent,
    deleteEvent,
    cancelScheduledMessage,
    updateScheduledMessage,
    resendScheduledMessage,
    retryScheduledMessage,
    scheduleMessage,
    refetch,
    isLoading,
  } = useCalendar();
  const handleEventClick = (event: CalendarEvent) => {
    // Event details are handled by CalendarView; the planner shares this hook.
    void event;
  };

  const handleDismissReminder = async (id: string) => {
    await platform.from('reminders' as never).update({ dismissed: true } as never).eq('id', id);
    await refetch();
  };

  const handleSnoozeReminder = async (id: string, minutes: number) => {
    await platform
      .from('reminders' as never)
      .update({ remind_at: new Date(Date.now() + minutes * 60000).toISOString(), notified: false } as never)
      .eq('id', id);
    await refetch();
  };

  const handleCompleteReminder = async (id: string) => {
    await platform
      .from('reminders' as never)
      .update({ completed: true, notified: true, dismissed: true } as never)
      .eq('id', id);
    await refetch();
  };

  return (
    <div className={styles.page}>
      <div className={styles.mainContent}>
        <CalendarView
          onEventClick={handleEventClick}
          events={events}
          createEvent={createEvent}
          updateEvent={updateEvent}
          deleteEvent={deleteEvent}
          isLoading={isLoading}
          reminders={reminders}
          createReminder={createReminder}
          onRemindersChanged={refetch}
        />
      </div>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTop}>
          <ReminderBell
            reminders={reminders}
            onDismiss={handleDismissReminder}
            onSnooze={handleSnoozeReminder}
            onComplete={handleCompleteReminder}
          />
        </div>
        <div className={styles.sidebarContent}>
          <PersonalPlanner
            events={events}
            pendingReminders={pendingReminders}
            onEventClick={handleEventClick}
          />
          <ScheduledMessages
            messages={scheduledMessages}
            onCancel={cancelScheduledMessage}
            onSchedule={scheduleMessage as any}
            onResend={resendScheduledMessage}
            onRetry={retryScheduledMessage}
            onEditSave={updateScheduledMessage}
          />
        </div>
      </aside>
    </div>
  );
}
