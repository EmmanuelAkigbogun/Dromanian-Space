import { useState, useEffect, useCallback } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Spinner } from '@/components/ui/Spinner';
import { Avatar } from '@/components/ui/Avatar';
import { useTasks } from '@/hooks/useTasks';
import { supabase } from '@/lib/supabase';
import type { Task, TaskStatus, TaskPriority } from '@/types/task';
import type { TaskLabel } from '@/types/task';
import type { Profile } from '@/types';
import { TASK_STATUS_OPTIONS, TASK_PRIORITY_OPTIONS } from '@/types/task';
import { toLocalDatetimeString } from '@/utils';
import styles from './TaskDialog.module.css';

interface TaskDialogProps {
  open: boolean;
  onClose: () => void;
  task?: Task | null;
  workspaceId: string;
  projectId?: string;
  defaultTitle?: string;
  defaultDescription?: string;
  defaultLinkedMessageId?: string;
}

export function TaskDialog({
  open,
  onClose,
  task,
  workspaceId,
  projectId,
  defaultTitle,
  defaultDescription,
  defaultLinkedMessageId,
}: TaskDialogProps) {
  const { createTask, updateTask, getLabels } = useTasks();
  const isEditing = !!task;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [priority, setPriority] = useState<TaskPriority>('none');
  const [dueDate, setDueDate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [selectedAssignees, setSelectedAssignees] = useState<string[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<Profile[]>([]);
  const [labels, setLabels] = useState<TaskLabel[]>([]);

  useEffect(() => {
    if (!open) return;

    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? '');
      setStatus(task.status);
      setPriority(task.priority);
      setAllDay(false);
      setDueDate(task.due_date ? toLocalDatetimeString(new Date(task.due_date)) : '');
      setStartDate(task.start_date ? toLocalDatetimeString(new Date(task.start_date)) : '');
    } else {
      setTitle(defaultTitle ?? '');
      setDescription(defaultDescription ?? '');
      setStatus('todo');
      setPriority('none');
      setAllDay(false);
      setDueDate('');
      setStartDate('');
      setSelectedAssignees([]);
      setSelectedLabels([]);
    }
    setError(null);
  }, [open, task, defaultTitle, defaultDescription]);

  useEffect(() => {
    if (!open || !workspaceId) return;

    const loadData = async () => {
      const [membersResult, labelsResult] = await Promise.all([
        supabase
          .from('workspace_members' as any)
          .select('user_id')
          .eq('workspace_id', workspaceId),
        getLabels(),
      ]);

      if (membersResult.data) {
        const userIds = (membersResult.data as unknown as { user_id: string }[]).map((m) => m.user_id);
        if (userIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles' as any)
            .select('*')
            .in('id', userIds);
          setMembers((profiles as unknown as Profile[]) ?? []);
        }
      }

      setLabels(labelsResult);
    };

    loadData();
  }, [open, workspaceId, getLabels]);

  useEffect(() => {
    if (!task || !open) return;

    const loadTaskData = async () => {
      const { data: assigneeData } = await supabase
        .from('task_assignees' as any)
        .select('user_id')
        .eq('task_id', task.id);

      if (assigneeData) {
        setSelectedAssignees((assigneeData as unknown as { user_id: string }[]).map((a) => a.user_id));
      }

      const { data: labelData } = await supabase
        .from('task_label_assignments' as any)
        .select('label_id')
        .eq('task_id', task.id);

      if (labelData) {
        setSelectedLabels((labelData as unknown as { label_id: string }[]).map((l) => l.label_id));
      }
    };

    loadTaskData();
  }, [task, open]);

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (isEditing && task) {
        const success = await updateTask(task.id, {
          title: title.trim(),
          description: description.trim() || undefined,
          status,
          priority,
          due_date: dueDate ? new Date(dueDate).toISOString() : null,
          start_date: startDate ? new Date(startDate).toISOString() : null,
        });

        if (success) {
          onClose();
        }
      } else {
        const newTask = await createTask({
          title: title.trim(),
          description: description.trim() || undefined,
          status,
          priority,
          due_date: dueDate ? new Date(dueDate).toISOString() : undefined,
          start_date: startDate ? new Date(startDate).toISOString() : undefined,
          assigneeIds: selectedAssignees.length > 0 ? selectedAssignees : undefined,
          labelIds: selectedLabels.length > 0 ? selectedLabels : undefined,
          project_id: projectId,
          linked_message_id: defaultLinkedMessageId,
        });

        if (newTask) {
          onClose();
        }
      }
    } catch {
      setError('Failed to save task');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    title,
    description,
    status,
    priority,
    dueDate,
    startDate,
    selectedAssignees,
    selectedLabels,
    isEditing,
    task,
    createTask,
    updateTask,
    onClose,
    defaultLinkedMessageId,
    projectId,
  ]);

  const handleAllDayChange = useCallback((checked: boolean) => {
    setAllDay(checked);
    const toDateOnly = (prev: string) => (prev.includes('T') ? prev.split('T')[0] : prev);
    const toDateTime = (prev: string) => (prev && !prev.includes('T') ? `${prev}T00:00` : prev);
    if (checked) {
      setStartDate((prev) => toDateOnly(prev));
      setDueDate((prev) => toDateOnly(prev));
    } else {
      setStartDate((prev) => toDateTime(prev));
      setDueDate((prev) => toDateTime(prev));
    }
  }, []);

  const toggleAssignee = useCallback((userId: string) => {
    setSelectedAssignees((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId],
    );
  }, []);

  const toggleLabel = useCallback((labelId: string) => {
    setSelectedLabels((prev) =>
      prev.includes(labelId)
        ? prev.filter((id) => id !== labelId)
        : [...prev, labelId],
    );
  }, []);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEditing ? 'Edit Task' : 'Create Task'}
      size="lg"
    >
      <div className={styles.fieldGroup}>
        {error && (
          <div style={{ color: 'var(--color-error)', fontSize: 'var(--font-size-sm)' }}>
            {error}
          </div>
        )}

        <Input
          label="Title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title"
          autoFocus
        />

        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add a more detailed description..."
          rows={4}
        />

        <div className={styles.row}>
          <Select
            label="Status"
            options={TASK_STATUS_OPTIONS}
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus)}
          />
          <Select
            label="Priority"
            options={TASK_PRIORITY_OPTIONS.map((p) => ({ value: p.value, label: p.label }))}
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority)}
          />
        </div>

        <Switch
          label="All Day"
          checked={allDay}
          onChange={(e) => handleAllDayChange(e.target.checked)}
        />

        <div className={styles.row}>
          <Input
            label="Start"
            type={allDay ? 'date' : 'datetime-local'}
            value={allDay ? startDate.split('T')[0] : startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <Input
            label="Due"
            type={allDay ? 'date' : 'datetime-local'}
            value={allDay ? dueDate.split('T')[0] : dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>

        {members.length > 0 && (
          <div className={styles.assigneeSection}>
            <span className={styles.sectionLabel}>Assignees</span>
            <div className={styles.assigneeList}>
              {members.map((member) => {
                const isSelected = selectedAssignees.includes(member.id);
                return (
                  <button
                    key={member.id}
                    type="button"
                    className={`${styles.assigneeChip} ${isSelected ? styles.assigneeChipActive : ''}`}
                    onClick={() => toggleAssignee(member.id)}
                  >
                    <span className={styles.assigneeAvatars}>
                      <Avatar src={member.avatar_url ?? undefined} name={member.display_name ?? member.username ?? member.email} size="xs" />
                    </span>
                    {member.display_name ?? member.username ?? member.email}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {labels.length > 0 && (
          <div className={styles.labelSection}>
            <span className={styles.sectionLabel}>Labels</span>
            <div className={styles.labelList}>
              {labels.map((label) => {
                const isSelected = selectedLabels.includes(label.id);
                return (
                  <button
                    key={label.id}
                    type="button"
                    className={`${styles.labelChip} ${isSelected ? styles.labelChipActive : ''}`}
                    onClick={() => toggleLabel(label.id)}
                    style={{ backgroundColor: `${label.color}22`, color: label.color }}
                  >
                    <span className={styles.labelDot} style={{ backgroundColor: label.color }} />
                    {label.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className={styles.submitRow}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.submitButton}
            onClick={handleSubmit}
            disabled={isSubmitting || !title.trim()}
          >
            {isSubmitting ? (
              <Spinner size="sm" color="inverse" />
            ) : isEditing ? (
              'Save Changes'
            ) : (
              'Create Task'
            )}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
