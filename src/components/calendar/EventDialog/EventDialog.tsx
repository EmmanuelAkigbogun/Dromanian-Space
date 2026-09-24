import { useState, useEffect } from 'react';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { Input } from '@/components/ui/Input/Input';
import { Textarea } from '@/components/ui/Textarea/Textarea';
import { Select } from '@/components/ui/Select/Select';
import { Switch } from '@/components/ui/Switch/Switch';
import { Avatar } from '@/components/ui/Avatar/Avatar';
import { Badge } from '@/components/ui/Badge/Badge';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import type { CalendarEvent, CalendarReminder } from '@/types';
import styles from './EventDialog.module.css';

interface EventDialogProps {
  event: CalendarEvent | null;
  existingReminder?: CalendarReminder | null;
  onSave: (event: Omit<CalendarEvent, 'id' | 'created_at' | 'updated_at' | 'created_by'>) => Promise<CalendarEvent | null>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
  createReminder: (reminder: Omit<CalendarReminder, 'id' | 'created_at' | 'user_id' | 'notified' | 'dismissed'>) => Promise<CalendarReminder | null>;
  onRemindersChanged: () => Promise<void>;
}

const COLORS = ['#82A6B1', '#2D8A4E', '#B8860B', '#C43E3E', '#4A7C9B', '#9B59B6', '#E67E22', '#1ABC9C'];

const REMINDER_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: '0', label: 'At event start' },
  { value: '5', label: '5 minutes before' },
  { value: '15', label: '15 minutes before' },
  { value: '30', label: '30 minutes before' },
  { value: '60', label: '1 hour before' },
  { value: '1440', label: '1 day before' },
];

const REMINDER_OPTION_VALUES = new Set(REMINDER_OPTIONS.map((o) => o.value));

function toLocalDatetimeString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function EventDialog({ event, existingReminder, onSave, onDelete, onClose, createReminder, onRemindersChanged }: EventDialogProps) {
  const { currentWorkspace } = useWorkspace();
  const { userId } = useAuth();
  const [title, setTitle] = useState(event?.title || '');
  const [description, setDescription] = useState(event?.description || '');
  const [startTime, setStartTime] = useState(event ? toLocalDatetimeString(new Date(event.start_at)) : toLocalDatetimeString(new Date()));
  const [endTime, setEndTime] = useState(event ? toLocalDatetimeString(new Date(event.end_at)) : toLocalDatetimeString(new Date(Date.now() + 3600000)));
  const [allDay, setAllDay] = useState(event?.all_day || false);
  const [location, setLocation] = useState(event?.location || '');
  const [color, setColor] = useState(event?.color || COLORS[0]);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<Array<{ user_id: string; username: string; avatar_url: string | null }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initialReminderOption = () => {
    if (!event || !existingReminder) return 'none';
    const minutes = Math.round((new Date(event.start_at).getTime() - new Date(existingReminder.remind_at).getTime()) / 60000);
    return REMINDER_OPTION_VALUES.has(String(minutes)) ? String(minutes) : '0';
  };
  const [reminderOption, setReminderOption] = useState<string>(initialReminderOption);

  useEffect(() => {
    if (event && existingReminder) {
      const minutes = Math.round((new Date(event.start_at).getTime() - new Date(existingReminder.remind_at).getTime()) / 60000);
      if (REMINDER_OPTION_VALUES.has(String(minutes))) setReminderOption(String(minutes));
    }
  }, [event, existingReminder]);

  useEffect(() => {
    if (!currentWorkspace?.id) return;
    const fetchMembers = async () => {
      const { data: memberData, error: memberError } = await supabase
        .from('workspace_members' as never)
        .select('user_id')
        .eq('workspace_id', currentWorkspace.id);
      if (memberError || !memberData || memberData.length === 0) return;

      const userIds = (memberData as { user_id: string }[]).map((m) => m.user_id);
      const { data: profileData } = await supabase
        .from('profiles' as never)
        .select('id, username, avatar_url')
        .in('id', userIds);

      const profilesMap = new Map<string, { username: string; avatar_url: string | null }>();
      (profileData as Array<{ id: string; username: string; avatar_url: string | null }> | null)?.forEach((p) => {
        profilesMap.set(p.id, { username: p.username, avatar_url: p.avatar_url });
      });

      const members = userIds.map((uid) => ({
        user_id: uid,
        username: profilesMap.get(uid)?.username || 'Unknown',
        avatar_url: profilesMap.get(uid)?.avatar_url || null,
      }));
      setWorkspaceMembers(members);
    };
    fetchMembers();
  }, [currentWorkspace?.id]);

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await onSave({
        workspace_id: currentWorkspace?.id || '',
        user_id: userId || '',
        title: title.trim(),
        description: description.trim() || null,
        start_at: new Date(startTime).toISOString(),
        end_at: new Date(endTime).toISOString(),
        all_day: allDay,
        location: location.trim() || null,
        color,
        project_id: null,
        task_id: null,
      });

      if (saved?.id) {
        if (reminderOption === 'none') {
          if (existingReminder?.id) {
            await supabase.from('reminders' as never).delete().eq('id', existingReminder.id);
          }
        } else {
          const remindAt = new Date(new Date(saved.start_at).getTime() - Number(reminderOption) * 60000).toISOString();
          if (existingReminder?.id) {
            await supabase.from('reminders' as never).update({ remind_at: remindAt, title: saved.title } as never).eq('id', existingReminder.id);
          } else {
            await createReminder({
              entity_type: 'event',
              entity_id: saved.id,
              title: saved.title,
              remind_at: remindAt,
            });
          }
        }
        await onRemindersChanged();
      }
    } catch {
      setError('Failed to save event');
    } finally {
      setSaving(false);
    }
  };

  const toggleParticipant = (userId: string) => {
    setSelectedParticipantIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const footer = (
    <div className={styles.footer}>
      {event && onDelete && (
        <button
          type="button"
          className={styles.deleteButton}
          onClick={async () => { await onDelete(); }}
        >
          Delete
        </button>
      )}
      <div className={styles.footerRight}>
        <button type="button" className={styles.cancelButton} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.saveButton}
          onClick={handleSubmit}
          disabled={saving || !title.trim()}
        >
          {saving ? 'Saving...' : event ? 'Update' : 'Create'}
        </button>
      </div>
    </div>
  );

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title={event ? 'Edit Event' : 'Create Event'}
      size="lg"
      footer={footer}
    >
      <div className={styles.form}>
        {error && <div className={styles.error}>{error}</div>}

        <Input
          label="Title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Event title"
        />

        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add description..."
          rows={3}
        />

        <Switch
          label="All Day"
          checked={allDay}
          onChange={(e) => setAllDay(e.target.checked)}
        />

        <div className={styles.timeRow}>
          <Input
            label="Start"
            type={allDay ? 'date' : 'datetime-local'}
            value={allDay ? startTime.split('T')[0] : startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
          <Input
            label="End"
            type={allDay ? 'date' : 'datetime-local'}
            value={allDay ? endTime.split('T')[0] : endTime}
            onChange={(e) => setEndTime(e.target.value)}
          />
        </div>

        <Input
          label="Location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Add location..."
        />

        <div className={styles.colorSection}>
          <span className={styles.sectionLabel}>Color</span>
          <div className={styles.colorGrid}>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`${styles.colorSwatch} ${color === c ? styles.colorSelected : ''}`}
                style={{ backgroundColor: c }}
                onClick={() => setColor(c)}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </div>

        <div className={styles.participantsSection}>
          <span className={styles.sectionLabel}>Participants</span>
          <div className={styles.participantsList}>
            {workspaceMembers.map((member) => (
              <button
                key={member.user_id}
                type="button"
                className={`${styles.participantItem} ${selectedParticipantIds.includes(member.user_id) ? styles.participantSelected : ''}`}
                onClick={() => toggleParticipant(member.user_id)}
              >
                <Avatar
                  src={member.avatar_url || undefined}
                  name={member.username}
                  size="sm"
                />
                <span className={styles.participantName}>{member.username}</span>
                {selectedParticipantIds.includes(member.user_id) && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>

        <Select
          label="Reminder"
          value={reminderOption}
          onChange={(e) => setReminderOption(e.target.value)}
          options={REMINDER_OPTIONS}
        />
      </div>
    </Dialog>
  );
}
