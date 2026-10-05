import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { generateId } from '@/utils';
import { attachScheduledFiles } from '@/lib/message/schedule';
import { createTypedNotification } from '@/features/notifications/service';
import type { ScheduleAttachmentMeta } from '@/lib/message/schedule';
import type {
  CalendarEvent,
  EventParticipant,
  CalendarReminder,
  ScheduledMessage,
  ScheduledMessageAttachment,
  UUID,
} from '@/types';

interface UseCalendarReturn {
  events: CalendarEvent[];
  isLoading: boolean;
  createEvent: (event: Omit<CalendarEvent, 'id' | 'created_at' | 'updated_at' | 'user_id'>) => Promise<CalendarEvent | null>;
  updateEvent: (id: string, updates: Partial<CalendarEvent>) => Promise<boolean>;
  deleteEvent: (id: string) => Promise<boolean>;
  getEventsForRange: (start: string, end: string) => Promise<CalendarEvent[]>;
  participants: EventParticipant[];
  addParticipant: (eventId: string, userId: string) => Promise<EventParticipant | null>;
  removeParticipant: (participantId: string) => Promise<boolean>;
  reminders: CalendarReminder[];
  createReminder: (reminder: Omit<CalendarReminder, 'id' | 'created_at' | 'user_id' | 'notified' | 'dismissed'>) => Promise<CalendarReminder | null>;
  scheduledMessages: ScheduledMessage[];
  scheduleMessage: (message: Omit<ScheduledMessage, 'id' | 'created_at' | 'user_id' | 'sent'>) => Promise<ScheduledMessage | null>;
  updateScheduledMessage: (id: string, updates: Partial<Pick<ScheduledMessage, 'content' | 'scheduled_at' | 'channel_id' | 'conversation_id'>>) => Promise<boolean>;
  resendScheduledMessage: (id: string) => Promise<boolean>;
  cancelScheduledMessage: (id: string) => Promise<boolean>;
  retryScheduledMessage: (id: string) => Promise<boolean>;
  planner: CalendarEvent[];
  pendingReminders: CalendarReminder[];
  refetch: () => Promise<void>;
}

export function useCalendar(): UseCalendarReturn {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [participants, setParticipants] = useState<EventParticipant[]>([]);
  const [reminders, setReminders] = useState<CalendarReminder[]>([]);
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchEvents = useCallback(async () => {
    if (!currentWorkspace?.id) { setIsLoading(false); return; }
    setIsLoading(true);
    const { data, error } = await supabase
      .from('calendar_events' as never)
      .select('*')
      .eq('workspace_id', currentWorkspace.id)
      .order('start_at', { ascending: true });
    if (!error && data) setEvents(data as unknown as CalendarEvent[]);
    setIsLoading(false);
  }, [currentWorkspace?.id]);

  const fetchParticipants = useCallback(async () => {
    if (!currentWorkspace?.id) return;
    const eventIds = events.map((e) => e.id);
    if (eventIds.length === 0) { setParticipants([]); return; }
    const { data, error } = await supabase
      .rpc('get_events_participants', { p_event_ids: eventIds });
    if (!error && data) setParticipants(data as unknown as EventParticipant[]);
  }, [events, currentWorkspace?.id]);

  const fetchReminders = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase
      .from('reminders' as never)
      .select('*')
      .or(`user_id.eq.${userId},recipients.cs.{${userId}}`)
      .order('remind_at', { ascending: true });
    if (!error && data) {
      const rows = data as unknown as CalendarReminder[];
      setReminders(
        rows.filter((r) =>
          r.recipients && r.recipients.length > 0
            ? r.recipients.includes(userId)
            : r.user_id === userId,
        ),
      );
    }
  }, [userId]);

  const fetchScheduledMessages = useCallback(async () => {
    if (!userId || !currentWorkspace?.id) {
      setScheduledMessages([]);
      return;
    }
    const [msgRes, chRes, convRes] = await Promise.all([
      supabase
        .from('scheduled_messages' as never)
        .select('*')
        .eq('user_id', userId)
        .order('scheduled_at', { ascending: true }),
      supabase
        .from('channels' as never)
        .select('id')
        .eq('workspace_id', currentWorkspace.id),
      supabase
        .from('direct_conversations' as never)
        .select('id')
        .eq('workspace_id', currentWorkspace.id),
    ]);
    if (msgRes.error || !msgRes.data) {
      setScheduledMessages([]);
      return;
    }
    const channelIds = new Set(((chRes.data ?? []) as unknown as Array<{ id: string }>).map((c) => c.id));
    const convIds = new Set(((convRes.data ?? []) as unknown as Array<{ id: string }>).map((c) => c.id));
    const messages = (msgRes.data as unknown as ScheduledMessage[]).filter(
      (m) => (m.channel_id && channelIds.has(m.channel_id)) || (m.conversation_id && convIds.has(m.conversation_id)),
    );

    const msgIds = messages.map((m) => m.id);
    const attachmentsByMsg = new Map<string, ScheduledMessageAttachment[]>();
    if (msgIds.length > 0) {
      const { data: attData } = await supabase
        .from('scheduled_message_attachments' as never)
        .select('*')
        .in('scheduled_message_id', msgIds);
      for (const att of (attData ?? []) as ScheduledMessageAttachment[]) {
        const list = attachmentsByMsg.get(att.scheduled_message_id) ?? [];
        list.push(att);
        attachmentsByMsg.set(att.scheduled_message_id, list);
      }
    }

    setScheduledMessages(
      messages.map((m) => ({ ...m, attachments: attachmentsByMsg.get(m.id) ?? [] })),
    );
  }, [userId, currentWorkspace?.id]);

  const refetch = useCallback(async () => {
    await Promise.all([fetchEvents(), fetchReminders(), fetchScheduledMessages()]);
  }, [fetchEvents, fetchReminders, fetchScheduledMessages]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    fetchParticipants();
  }, [fetchParticipants]);

  const createEvent = useCallback(
    async (eventData: Omit<CalendarEvent, 'id' | 'created_at' | 'updated_at' | 'user_id'>) => {
      if (!currentWorkspace?.id || !userId) return null;
      const id = generateId();
      const now = new Date().toISOString();
      const payload = {
        id,
        user_id: userId,
        ...eventData,
        created_at: now,
        updated_at: now,
      };
      const { data, error } = await supabase
        .from('calendar_events' as never)
        .insert(payload as never)
        .select()
        .single();
      if (error || !data) return null;
      const newEvent = data as unknown as CalendarEvent;
      setEvents((prev) => [...prev, newEvent].sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime()));

      if (eventData.title && currentWorkspace?.id) {
        const startDate = new Date(eventData.start_at);
        const dateStr = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const timeStr = eventData.all_day ? 'All day' : startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

        const creatorProfile = await supabase.from('profiles').select('display_name, username').eq('id', userId).single();
        const creatorName = creatorProfile.data?.display_name || creatorProfile.data?.username || 'Someone';

        const participants = await supabase.from('event_participants' as never).select('user_id').eq('event_id', id);
        const participantIds = ((participants.data || []) as any[]).map((p: any) => p.user_id).filter((pid: string) => pid !== userId);

        const allRecipients = [...new Set(participantIds)];
        const link = `/calendar`;

        await Promise.allSettled(
          allRecipients.map((recipientId) =>
            createTypedNotification(
              recipientId,
              'system',
              `New event: ${eventData.title}`,
              `${creatorName} created an event "${eventData.title}" on ${dateStr} at ${timeStr}`,
              link,
              'calendar',
              'event',
              id,
              userId,
              currentWorkspace.id,
            ),
          ),
        );
      }

      return newEvent;
    },
    [currentWorkspace?.id, userId]
  );

  const updateEvent = useCallback(async (id: string, updates: Partial<CalendarEvent>) => {
    const { error } = await supabase
      .from('calendar_events' as never)
      .update({ ...updates, updated_at: new Date().toISOString() } as never)
      .eq('id', id);
    if (error) return false;
    setEvents((prev) =>
      prev.map((e) => (e.id === id ? { ...e, ...updates, updated_at: new Date().toISOString() } : e))
    );
    return true;
  }, []);

  const deleteEvent = useCallback(async (id: string) => {
    const { error } = await supabase.from('calendar_events' as never).delete().eq('id', id);
    if (error) return false;
    await supabase.from('reminders' as never).delete().eq('entity_type', 'event').eq('entity_id', id);
    setEvents((prev) => prev.filter((e) => e.id !== id));
    setReminders((prev) => prev.filter((r) => !(r.entity_type === 'event' && r.entity_id === id)));
    return true;
  }, []);

  const getEventsForRange = useCallback(async (start: string, end: string) => {
    if (!currentWorkspace?.id) return [];
    const { data, error } = await supabase
      .from('calendar_events' as never)
      .select('*')
      .eq('workspace_id', currentWorkspace.id)
      .gte('start_at', start)
      .lte('end_at', end)
      .order('start_at', { ascending: true });
    if (error || !data) return [];
    return data as unknown as CalendarEvent[];
  }, [currentWorkspace?.id]);

  const addParticipant = useCallback(async (eventId: string, userId: string) => {
    const { data, error } = await supabase
      .rpc('add_event_participant', { p_event_id: eventId, p_user_id: userId });
    if (error || !data) return null;
    const participant = { id: data as string, event_id: eventId, user_id: userId, status: 'pending', created_at: new Date().toISOString() } as EventParticipant;
    setParticipants((prev) => [...prev, participant]);
    return participant;
  }, []);

  const removeParticipant = useCallback(async (participantId: string) => {
    const { error } = await supabase.rpc('remove_event_participant_by_id', { p_participant_id: participantId });
    if (error) return false;
    setParticipants((prev) => prev.filter((p) => p.id !== participantId));
    return true;
  }, []);

  const createReminder = useCallback(
    async (reminderData: Omit<CalendarReminder, 'id' | 'created_at' | 'user_id' | 'notified' | 'dismissed'>) => {
      if (!userId) return null;
      const id = generateId();
      const payload = {
        id,
        user_id: userId,
        ...reminderData,
        created_at: new Date().toISOString(),
      };
      const { data, error } = await supabase
        .from('reminders' as never)
        .insert(payload as never)
        .select()
        .single();
      if (error || !data) return null;
      const reminder = data as unknown as CalendarReminder;
      setReminders((prev) => [...prev, reminder]);
      return reminder;
    },
    [userId]
  );

  const scheduleMessage = useCallback(
    async (
      messageData: Omit<ScheduledMessage, 'id' | 'created_at' | 'user_id' | 'sent' | 'attachments'> & { files?: File[]; attachments?: ScheduleAttachmentMeta[] },
      onFileProgress?: (file: File, percent: number) => void,
    ) => {
      if (!userId || !currentWorkspace?.id) return null;
      const id = generateId();
      const { files, attachments, ...msgData } = messageData;
      const hasAttachments = (files?.length ?? 0) > 0 || (attachments?.length ?? 0) > 0;
      // Drafts are not delivered until every attachment has been uploaded.
      const payload = {
        id,
        user_id: userId,
        ...msgData,
        sent: false,
        status: hasAttachments ? 'draft' : 'pending',
        created_at: new Date().toISOString(),
      };
      const { data, error } = await supabase
        .from('scheduled_messages' as never)
        .insert(payload as never)
        .select()
        .single();
      if (error || !data) return null;
      let msg = data as unknown as ScheduledMessage;

      if (hasAttachments) {
        const uploaded = await attachScheduledFiles(msg.id, userId, files, attachments, onFileProgress);
        if (uploaded) {
          const { error: queueError } = await supabase.rpc('queue_scheduled_message' as never, { p_id: msg.id } as never);
          if (!queueError) msg = { ...msg, status: 'pending' };
        }
      }

      const saved = { ...msg, attachments: attachments ?? [] } as ScheduledMessage;
      setScheduledMessages((prev) => [...prev, saved].sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()));
      return saved;
    },
    [currentWorkspace?.id, userId]
  );

  const updateScheduledMessage = useCallback(async (id: string, updates: Partial<Pick<ScheduledMessage, 'content' | 'scheduled_at' | 'channel_id' | 'conversation_id'>>) => {
    const { error } = await supabase
      .from('scheduled_messages' as never)
      .update(updates as never)
      .eq('id', id);
    if (error) return false;
    setScheduledMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...updates } : m))
    );
    return true;
  }, []);

  // Resending queues a copy due now and delivers it through the same
  // transactional server path as scheduled delivery (no client-side send).
  const resendScheduledMessage = useCallback(async (id: string) => {
    const { data, error } = await supabase.rpc('resend_scheduled_message' as never, { p_id: id } as never);
    if (error || !data) return false;
    const { data: copy } = await supabase
      .from('scheduled_messages' as never)
      .select('*')
      .eq('id', data as unknown as string)
      .maybeSingle();
    if (copy) {
      setScheduledMessages((prev) =>
        [...prev, copy as unknown as ScheduledMessage].sort(
          (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
        ),
      );
    }
    return true;
  }, []);

  // A failed message is re-queued by setting it back to pending (the server
  // resets its attempts); delivery itself only happens server-side.
  const retryScheduledMessage = useCallback(async (id: string) => {
    const { error } = await supabase
      .from('scheduled_messages' as never)
      .update({ status: 'pending' } as never)
      .eq('id', id);
    if (error) return false;
    setScheduledMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: 'pending', last_error: null } : m)));
    return true;
  }, []);

  const cancelScheduledMessage = useCallback(async (id: string) => {
    const { error } = await supabase.from('scheduled_messages' as never).delete().eq('id', id);
    if (error) return false;
    setScheduledMessages((prev) => prev.filter((m) => m.id !== id));
    return true;
  }, []);

  const planner = events.filter((e) => {
    const now = new Date();
    const start = new Date(e.start_at);
    const diffDays = (start.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays >= -1 && diffDays <= 7;
  });

  const pendingReminders = reminders.filter((r) => !r.dismissed && new Date(r.remind_at) <= new Date());

  return {
    events,
    isLoading,
    createEvent,
    updateEvent,
    deleteEvent,
    getEventsForRange,
    participants,
    addParticipant,
    removeParticipant,
    reminders,
    createReminder,
    scheduledMessages,
    scheduleMessage,
    updateScheduledMessage,
    resendScheduledMessage,
    cancelScheduledMessage,
    retryScheduledMessage,
    planner,
    pendingReminders,
    refetch,
  };
}
