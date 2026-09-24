import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useTasks } from '@/hooks/useTasks';
import { useToast } from '@/components/ui/Toast';
import { supabase } from '@/lib/supabase';
import { createTypedNotification } from '@/features/notifications/service';
import { resolveTaskStatusLabel } from '@/lib/tasks/status';
import { Spinner } from '@/components/ui/Spinner';
import { Avatar } from '@/components/ui/Avatar';
import { Switch } from '@/components/ui/Switch';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog/ConfirmDialog';
import { TaskComments } from '@/components/tasks/TaskComments';
import { TaskActivity } from '@/components/tasks/TaskActivity';
import type { Task, TaskStatus, TaskPriority } from '@/types/task';
import { getStatusColor, getStatusLabel, getPriorityColor, TASK_STATUS_OPTIONS, TASK_PRIORITY_OPTIONS } from '@/types/task';
import { toLocalDatetimeString, formatDateTime, formatDateOnly } from '@/utils';
import type { Profile, ProjectColumn } from '@/types';
import styles from './TaskDetail.module.css';

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
  onUpdate: (taskId: string, input: { title?: string; description?: string; status?: TaskStatus; priority?: TaskPriority; due_date?: string | null; start_date?: string | null }) => Promise<boolean>;
  onDelete: (taskId: string) => Promise<boolean>;
  onArchive: (taskId: string) => Promise<boolean>;
  onRestore?: (taskId: string) => Promise<boolean>;
  onStatusChange: (taskId: string, status: TaskStatus) => Promise<boolean>;
  onCustomStatusesChange?: () => void;
  onTaskUpdated?: (task: Task) => void;
  customStatuses?: ProjectColumn[];
  canEdit?: boolean;
}

export function TaskDetail({
  task,
  onClose,
  onUpdate,
  onDelete,
  onArchive,
  onRestore,
  onStatusChange,
  onCustomStatusesChange,
  onTaskUpdated,
  customStatuses: _customStatuses = [],
  canEdit = true,
}: TaskDetailProps) {
  const { userId } = useAuth();
  const { toast } = useToast();
  const { assignUser, unassignUser, getTaskAssignees, getLabels, getTaskLabels, assignLabel, unassignLabel, createLabel, duplicateTask } = useTasks();
  const [currentTask, setCurrentTask] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [showPriorityDropdown, setShowPriorityDropdown] = useState(false);
  const [editingDueDate, setEditingDueDate] = useState(false);
  const [editingStartDate, setEditingStartDate] = useState(false);
  const [dueDateValue, setDueDateValue] = useState('');
  const [startDateValue, setStartDateValue] = useState('');
  const [dueDateAllDay, setDueDateAllDay] = useState(false);
  const [startDateAllDay, setStartDateAllDay] = useState(false);
  const [assignees, setAssignees] = useState<Profile[]>([]);
  const [taskLabelIds, setTaskLabelIds] = useState<string[]>([]);
  const [allLabels, setAllLabels] = useState<{ id: string; name: string; color: string }[]>([]);
  const [showAssigneeDropdown, setShowAssigneeDropdown] = useState(false);
  const [showLabelDropdown, setShowLabelDropdown] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState('#6366f1');
  const [members, setMembers] = useState<Profile[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descInputRef = useRef<HTMLTextAreaElement>(null);
  const dueDateInputRef = useRef<HTMLInputElement>(null);
  const startDateInputRef = useRef<HTMLInputElement>(null);
  const localUpdateRef = useRef(false);

  useEffect(() => {
    if (localUpdateRef.current) {
      localUpdateRef.current = false;
      return;
    }
    setCurrentTask(task);
    setTitle(task.title);
    setDescription(task.description ?? '');
  }, [task]);

  const loadAssignees = useCallback(async () => {
    const assignments = await getTaskAssignees(task.id);
    if (assignments.length === 0) {
      setAssignees([]);
      return;
    }
    const userIds = assignments.map((a) => a.user_id);
    const { data } = await supabase
      .from('profiles' as any)
      .select('*')
      .in('id', userIds);
    setAssignees((data as unknown as Profile[]) ?? []);
  }, [task.id, getTaskAssignees]);

  const loadLabels = useCallback(async () => {
    const [labels, assignments] = await Promise.all([
      getLabels(),
      getTaskLabels(task.id),
    ]);
    setAllLabels(labels.map((l) => ({ id: l.id, name: l.name, color: l.color })));
    setTaskLabelIds(assignments.map((a) => a.label_id));
  }, [task.id, getLabels, getTaskLabels]);

  const loadMembers = useCallback(async () => {
    const { data: memberData } = await supabase
      .from('workspace_members' as any)
      .select('user_id')
      .eq('workspace_id', task.workspace_id);

    if (memberData && memberData.length > 0) {
      const userIds = (memberData as unknown as { user_id: string }[]).map((m) => m.user_id);
      const { data: profiles } = await supabase
        .from('profiles' as any)
        .select('*')
        .in('id', userIds);
      setMembers((profiles as unknown as Profile[]) ?? []);
    }
  }, [task.workspace_id]);

  useEffect(() => {
    loadAssignees();
    loadLabels();
    loadMembers();
  }, [loadAssignees, loadLabels, loadMembers]);

  const handleTitleBlur = useCallback(async () => {
    setEditingTitle(false);
    if (title.trim() && title !== currentTask.title) {
      setIsSaving(true);
      await onUpdate(currentTask.id, { title: title.trim() });
      setCurrentTask((prev) => ({ ...prev, title: title.trim() }));
      setIsSaving(false);
    } else {
      setTitle(currentTask.title);
    }
  }, [title, currentTask, onUpdate]);

  const handleDescriptionBlur = useCallback(async () => {
    setEditingDescription(false);
    if (description !== (currentTask.description ?? '')) {
      setIsSaving(true);
      await onUpdate(currentTask.id, { description: description.trim() || undefined });
      setCurrentTask((prev) => ({ ...prev, description: description.trim() || null }));
      setIsSaving(false);
    }
  }, [description, currentTask, onUpdate]);

  const handleToggleLabel = useCallback(async (labelId: string) => {
    const isAssigned = taskLabelIds.includes(labelId);
    if (isAssigned) {
      await unassignLabel(currentTask.id, labelId);
      setTaskLabelIds((prev) => prev.filter((id) => id !== labelId));
    } else {
      await assignLabel(currentTask.id, labelId);
      setTaskLabelIds((prev) => [...prev, labelId]);
    }
  }, [currentTask.id, taskLabelIds, assignLabel, unassignLabel]);

  const handleCreateLabel = useCallback(async () => {
    if (!newLabelName.trim()) return;
    const label = await createLabel(newLabelName.trim(), newLabelColor);
    if (label) {
      setAllLabels((prev) => [...prev, { id: label.id, name: label.name, color: label.color }]);
      await assignLabel(currentTask.id, label.id);
      setTaskLabelIds((prev) => [...prev, label.id]);
      setNewLabelName('');
    }
  }, [newLabelName, newLabelColor, createLabel, assignLabel, currentTask.id]);

  const applyStatus = useCallback(async (statusId: string) => {
    const isDefault = TASK_STATUS_OPTIONS.some((o) => o.value === statusId);
    const updated = { ...currentTask, status: statusId as TaskStatus };
    setCurrentTask(updated);
    if (isDefault) {
      await onStatusChange(currentTask.id, statusId as TaskStatus);
    } else {
      const { error } = await supabase
        .from('tasks')
        .update({ status: statusId, updated_at: new Date().toISOString() })
        .eq('id', currentTask.id);
      if (error) {
        toast({ description: 'Failed to update status', variant: 'error' });
        setCurrentTask(currentTask);
        return;
      }
      notifyCustomStatusChange(currentTask.id, statusId).catch(() => {});
    }
    onTaskUpdated?.(updated);
  }, [currentTask, onStatusChange, onTaskUpdated, toast]);

  async function notifyCustomStatusChange(taskId: string, statusId: string) {
    if (!userId) return;
    const [taskRes, assigneesRes, actorRes, statusLabel] = await Promise.all([
      supabase.from('tasks' as any).select('title, workspace_id').eq('id', taskId).single(),
      supabase.from('task_assignees' as any).select('user_id').eq('task_id', taskId),
      supabase.from('profiles' as any).select('display_name, username').eq('id', userId).single(),
      resolveTaskStatusLabel(statusId),
    ]);
    const taskRow = taskRes.data as any;
    if (taskRes.error || !taskRow) return;
    const assigneeIds = ((assigneesRes.data || []) as any[])
      .map((a: any) => a.user_id)
      .filter((id: string) => id !== userId);
    if (assigneeIds.length === 0) return;
    const actorRow = actorRes.data as any;
    const actorName = actorRow?.display_name || actorRow?.username || 'Someone';
    const title = taskRow.title;
    const link = `/tasks/${taskId}`;
    await Promise.allSettled(
      assigneeIds.map((recipientId: string) =>
        createTypedNotification(
          recipientId,
          'system',
          `Task status changed: ${title}`,
          `${actorName} changed the status of "${title}" to ${statusLabel}`,
          link,
          'tasks',
          'task',
          taskId,
          userId,
          taskRow.workspace_id,
        ),
      ),
    );
  }

  const handleStatusChange = useCallback(
    async (statusId: string) => {
      setShowStatusDropdown(false);
      await applyStatus(statusId);
    },
    [applyStatus],
  );

  const handlePriorityChange = useCallback(
    async (priority: TaskPriority) => {
      setShowPriorityDropdown(false);
      const updated = { ...currentTask, priority };
      setCurrentTask(updated);
      await onUpdate(currentTask.id, { priority });
      onTaskUpdated?.(updated);
    },
    [currentTask, onUpdate, onTaskUpdated],
  );

  const handleAssign = useCallback(
    async (userId: string) => {
      await assignUser(currentTask.id, userId);
      await loadAssignees();
      setShowAssigneeDropdown(false);
    },
    [currentTask.id, assignUser, loadAssignees],
  );

  const handleUnassign = useCallback(
    async (userId: string) => {
      await unassignUser(currentTask.id, userId);
      await loadAssignees();
    },
    [currentTask.id, unassignUser, loadAssignees],
  );

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDelete = useCallback(async () => {
    await onDelete(currentTask.id);
    onClose();
  }, [currentTask.id, onDelete, onClose]);

  const handleArchive = useCallback(async () => {
    await onArchive(currentTask.id);
    onClose();
  }, [currentTask.id, onArchive, onClose]);

  const handleRestore = useCallback(async () => {
    if (!onRestore) return;
    await onRestore(currentTask.id);
    onClose();
  }, [currentTask.id, onRestore, onClose]);

  const handleDuplicate = useCallback(async () => {
    const duplicated = await duplicateTask(currentTask);
    if (duplicated) {
      toast({ description: 'Task duplicated', variant: 'success' });
    } else {
      toast({ description: 'Failed to duplicate task', variant: 'error' });
    }
  }, [currentTask, duplicateTask, toast]);

  const startEditingDueDate = useCallback(() => {
    setDueDateValue(currentTask.due_date ? toLocalDatetimeString(new Date(currentTask.due_date)) : '');
    setEditingDueDate(true);
    setTimeout(() => dueDateInputRef.current?.focus(), 0);
  }, [currentTask.due_date]);

  const handleDueDateAllDayChange = useCallback((checked: boolean) => {
    setDueDateAllDay(checked);
    setDueDateValue((prev) => {
      if (checked) return prev.includes('T') ? prev.split('T')[0] : prev;
      return prev && !prev.includes('T') ? `${prev}T00:00` : prev;
    });
  }, []);

  const normalizeDateValue = useCallback((value: string) => {
    return value && !value.includes('T') ? `${value}T00:00` : value;
  }, []);

  const handleDueDateBlur = useCallback(async () => {
    if (!editingDueDate) return;
    setEditingDueDate(false);
    const next = dueDateValue ? new Date(dueDateValue).toISOString() : null;
    if (next === currentTask.due_date) return;
    await onUpdate(currentTask.id, { due_date: next });
    setCurrentTask((prev) => ({ ...prev, due_date: next }));
    onTaskUpdated?.({ ...currentTask, due_date: next });
  }, [editingDueDate, dueDateValue, currentTask, onUpdate, onTaskUpdated]);

  const handleDueDateClear = useCallback(async () => {
    setEditingDueDate(false);
    if (!currentTask.due_date) return;
    await onUpdate(currentTask.id, { due_date: null });
    setCurrentTask((prev) => ({ ...prev, due_date: null }));
    onTaskUpdated?.({ ...currentTask, due_date: null });
  }, [currentTask, onUpdate, onTaskUpdated]);

  const startEditingStartDate = useCallback(() => {
    setStartDateValue(currentTask.start_date ? toLocalDatetimeString(new Date(currentTask.start_date)) : '');
    setEditingStartDate(true);
    setTimeout(() => startDateInputRef.current?.focus(), 0);
  }, [currentTask.start_date]);

  const handleStartDateAllDayChange = useCallback((checked: boolean) => {
    setStartDateAllDay(checked);
    setStartDateValue((prev) => {
      if (checked) return prev.includes('T') ? prev.split('T')[0] : prev;
      return prev && !prev.includes('T') ? `${prev}T00:00` : prev;
    });
  }, []);

  const handleStartDateBlur = useCallback(async () => {
    if (!editingStartDate) return;
    setEditingStartDate(false);
    const next = startDateValue ? new Date(startDateValue).toISOString() : null;
    if (next === currentTask.start_date) return;
    await onUpdate(currentTask.id, { start_date: next });
    setCurrentTask((prev) => ({ ...prev, start_date: next }));
    onTaskUpdated?.({ ...currentTask, start_date: next });
  }, [editingStartDate, startDateValue, currentTask, onUpdate, onTaskUpdated]);

  const handleStartDateClear = useCallback(async () => {
    setEditingStartDate(false);
    if (!currentTask.start_date) return;
    await onUpdate(currentTask.id, { start_date: null });
    setCurrentTask((prev) => ({ ...prev, start_date: null }));
    onTaskUpdated?.({ ...currentTask, start_date: null });
  }, [currentTask, onUpdate, onTaskUpdated]);

  const unassignedMembers = members.filter(
    (m) => !assignees.some((a) => a.id === m.id),
  );

  const [statusColumns, setStatusColumns] = useState<{ id: string; name: string; isCustom: boolean }[]>(() =>
    TASK_STATUS_OPTIONS.map((o) => ({ id: o.value, name: o.label, isCustom: false })),
  );
  const [statusesLoaded, setStatusesLoaded] = useState(false);

  const [isAddingStatus, setIsAddingStatus] = useState(false);
  const [newStatusName, setNewStatusName] = useState('');
  const [dragOverStatus, setDragOverStatus] = useState<string | null>(null);
  const [draggingColumn, setDraggingColumn] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const loadCustomStatuses = useCallback(async () => {
    const defaults = TASK_STATUS_OPTIONS.map((o) => ({ id: o.value, name: o.label, isCustom: false }));
    const { data } = await supabase
      .from('task_custom_statuses' as any)
      .select('*')
      .eq('task_id', task.id)
      .order('sort_order');
    const raw = (data as any[]) ?? [];
    const hiddenIds = new Set(
      raw.filter((c) => c.name?.startsWith('__hidden__:')).map((c) => c.name.replace('__hidden__:', ''))
    );
    const customs = raw
      .filter((c) => !c.name?.startsWith('__hidden__:'))
      .map((c) => ({ id: c.id, name: c.name, isCustom: true }));
    const visibleDefaults = defaults.filter((d) => !hiddenIds.has(d.id));

    if (task.status_order && Array.isArray(task.status_order)) {
      const allMap = new Map<string, { id: string; name: string; isCustom: boolean }>();
      for (const c of [...visibleDefaults, ...customs]) allMap.set(c.id, c);
      const restored = task.status_order
        .map((id) => allMap.get(id))
        .filter(Boolean) as { id: string; name: string; isCustom: boolean }[];
      const missing = [...visibleDefaults, ...customs].filter((c) => !restored.some((r) => r.id === c.id));
      if (restored.length > 0) {
        setStatusColumns([...restored, ...missing]);
        setStatusesLoaded(true);
        return;
      }
    }
    setStatusColumns([...visibleDefaults, ...customs]);
    setStatusesLoaded(true);
  }, [task.id]);

  const getStatusName = useCallback((statusId: string): string => {
    const col = statusColumns.find((c) => c.id === statusId);
    return col ? col.name : getStatusLabel(statusId as TaskStatus);
  }, [statusColumns]);

  useEffect(() => {
    loadCustomStatuses();
  }, [loadCustomStatuses]);

  const persistStatusOrder = useCallback(async (cols: { id: string; name: string; isCustom: boolean }[]) => {
    const order = cols.map((c) => c.id);
    await supabase
      .from('tasks')
      .update({ status_order: order })
      .eq('id', currentTask.id);
    const updated = { ...currentTask, status_order: order };
    setCurrentTask(updated);
    onTaskUpdated?.(updated);
  }, [currentTask.id, onTaskUpdated]);

  const handleStatusDragOver = useCallback((e: React.DragEvent, statusId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggingColumn) {
      setDragOverStatus(statusId);
    }
  }, [draggingColumn]);

  const handleStatusDragLeave = useCallback(() => {
    setDragOverStatus(null);
    setDragOverColumn(null);
  }, []);

  const handleStatusDrop = useCallback(async (e: React.DragEvent, statusId: string) => {
    e.preventDefault();
    setDragOverStatus(null);
    setDragOverColumn(null);
    if (draggingColumn) return;
    await applyStatus(statusId);
  }, [applyStatus, draggingColumn]);

  const handleStatusDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', currentTask.id);
  }, [currentTask.id]);

  const handleColumnDragStart = useCallback((e: React.DragEvent, columnId: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', columnId);
    setDraggingColumn(columnId);
  }, []);

  const handleColumnDragOver = useCallback((e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggingColumn && draggingColumn !== columnId) {
      setDragOverColumn(columnId);
    }
  }, [draggingColumn]);

  const handleColumnDrop = useCallback(async (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverColumn(null);
    if (!draggingColumn || draggingColumn === targetId) {
      setDraggingColumn(null);
      return;
    }
    const fromIdx = statusColumns.findIndex((c) => c.id === draggingColumn);
    const toIdx = statusColumns.findIndex((c) => c.id === targetId);
    if (fromIdx === -1 || toIdx === -1) {
      setDraggingColumn(null);
      return;
    }
    const next = [...statusColumns];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    setStatusColumns(next);
    persistStatusOrder(next);

    const customEntries = next.filter((c) => c.isCustom);
    await Promise.all(
      customEntries.map((c, i) =>
        supabase
          .from('task_custom_statuses' as any)
          .update({ sort_order: i })
          .eq('id', c.id)
      ),
    );
    onCustomStatusesChange?.();
    setDraggingColumn(null);
  }, [draggingColumn, statusColumns, onCustomStatusesChange]);

  const handleAddCustomStatus = useCallback(async () => {
    if (!newStatusName.trim()) return;
    const count = statusColumns.filter((c) => c.isCustom).length;
    const { data, error } = await supabase
      .from('task_custom_statuses' as any)
      .insert({ task_id: currentTask.id, name: newStatusName.trim(), sort_order: count })
      .select()
      .single();
    if (!error && data) {
      const next = [...statusColumns, { id: (data as any).id, name: (data as any).name, isCustom: true }];
      setStatusColumns(next);
      persistStatusOrder(next);
      onCustomStatusesChange?.();
    }
    setNewStatusName('');
    setIsAddingStatus(false);
  }, [newStatusName, statusColumns, currentTask.id, onCustomStatusesChange]);

  const handleDeleteCustomStatus = useCallback(async (columnId: string) => {
    const col = statusColumns.find((c) => c.id === columnId);
    if (!col) return;
    const next = statusColumns.filter((c) => c.id !== columnId);
    setStatusColumns(next);
    if (col.isCustom) {
      await supabase
        .from('task_custom_statuses' as any)
        .delete()
        .eq('id', columnId);
    } else {
      await supabase
        .from('task_custom_statuses' as any)
        .insert({ task_id: currentTask.id, name: `__hidden__:${columnId}`, sort_order: -1 });
    }
    await persistStatusOrder(next);
    onCustomStatusesChange?.();
  }, [statusColumns, currentTask.id, persistStatusOrder, onCustomStatusesChange]);

  return (
    <div className={styles.overlay}>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.headerLeft}>
            <span
              className={styles.statusBadge}
              style={{
                backgroundColor: `${getStatusColor(currentTask.status)}18`,
                color: getStatusColor(currentTask.status),
              }}
              onClick={() => canEdit && setShowStatusDropdown(!showStatusDropdown)}
            >
              <span className={styles.statusDot} style={{ backgroundColor: getStatusColor(currentTask.status) }} />
              {getStatusName(currentTask.status)}
            </span>
            {showStatusDropdown && (
              <div className={styles.dropdown}>
                {statusColumns.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`${styles.dropdownOption} ${currentTask.status === option.id ? styles.dropdownOptionActive : ''}`}
                    onClick={() => handleStatusChange(option.id)}
                  >
                    <span
                      className={styles.statusDot}
                      style={{ backgroundColor: getStatusColor(option.id as TaskStatus) }}
                    />
                    {option.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={styles.headerActions}>
            {isSaving && <Spinner size="sm" />}
            {canEdit && (
              <button
                type="button"
                className={styles.headerButton}
                onClick={handleDuplicate}
                title="Duplicate task"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
              </button>
            )}
            {canEdit && currentTask.archived_at && onRestore ? (
              <button
                type="button"
                className={styles.headerButton}
                onClick={handleRestore}
                title="Restore task"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 8 3 21 21 21 21 8" />
                  <path d="M1 3h15v5H1z" />
                  <path d="M10 12l3 3 4-4" />
                </svg>
              </button>
            ) : canEdit ? (
              <button
                type="button"
                className={styles.headerButton}
                onClick={handleArchive}
                title="Archive task"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="21 8 21 21 3 21 3 8" />
                  <rect x="1" y="3" width="22" height="5" />
                  <line x1="10" y1="12" x2="14" y2="12" />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              className={`${styles.headerButton} ${styles.closeButton}`}
              onClick={onClose}
              title="Close"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className={styles.panelBody}>
          {statusesLoaded && canEdit && (
            <div className={styles.statusBoardHint}>
              <span>Drag this task to a column to change its status.</span>
              <span>Drag a column header to reorder the statuses.</span>
            </div>
          )}
          {statusesLoaded && canEdit && <div className={styles.statusBoard}>
            {statusColumns.map((col) => {
              const isActive = col.id === currentTask.status;
              const isTaskDragOver = dragOverStatus === col.id;
              const isColDragOver = dragOverColumn === col.id;
              const isColDragging = draggingColumn === col.id;
              return (
                <div
                  key={col.id}
                  className={`${styles.statusColumn} ${isActive ? styles.statusColumnActive : ''} ${isTaskDragOver ? styles.statusColumnDragOver : ''} ${isColDragOver ? styles.statusColumnReorderOver : ''} ${isColDragging ? styles.statusColumnDragging : ''}`}
                  onDragOver={(e) => { handleStatusDragOver(e, col.id); handleColumnDragOver(e, col.id); }}
                  onDragLeave={handleStatusDragLeave}
                  onDrop={(e) => { handleStatusDrop(e, col.id); handleColumnDrop(e, col.id); }}
                >
                  <div
                    className={styles.statusColumnHeader}
                    draggable
                    onDragStart={(e) => handleColumnDragStart(e, col.id)}
                    onDragEnd={() => setDraggingColumn(null)}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className={styles.dragHandle}>
                      <circle cx="8" cy="6" r="2" />
                      <circle cx="16" cy="6" r="2" />
                      <circle cx="8" cy="12" r="2" />
                      <circle cx="16" cy="12" r="2" />
                      <circle cx="8" cy="18" r="2" />
                      <circle cx="16" cy="18" r="2" />
                    </svg>
                    <span
                      className={styles.statusColumnDot}
                      style={{ backgroundColor: getStatusColor(col.id as TaskStatus) }}
                    />
                    <span className={styles.statusColumnName}>{col.name}</span>
                    <button
                      type="button"
                      className={styles.deleteStatusBtn}
                      onClick={() => handleDeleteCustomStatus(col.id)}
                      title="Remove status"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                  </div>
                  {isActive && (
                    <div
                      className={styles.statusColumnTask}
                      draggable
                      onDragStart={handleStatusDragStart}
                    >
                      <span className={styles.statusColumnTaskTitle}>{currentTask.title}</span>
                    </div>
                  )}
                </div>
              );
            })}

            {isAddingStatus ? (
              <div className={styles.addStatusForm}>
                <input
                  type="text"
                  className={styles.addStatusInput}
                  placeholder="Status name"
                  value={newStatusName}
                  onChange={(e) => setNewStatusName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddCustomStatus();
                    if (e.key === 'Escape') { setIsAddingStatus(false); setNewStatusName(''); }
                  }}
                  autoFocus
                />
                <div className={styles.addStatusActions}>
                  <button type="button" className={styles.cancelBtn} onClick={() => { setIsAddingStatus(false); setNewStatusName(''); }}>
                    Cancel
                  </button>
                  <button type="button" className={styles.confirmBtn} onClick={handleAddCustomStatus} disabled={!newStatusName.trim()}>
                    Add
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className={styles.addStatusBtn}
                onClick={() => setIsAddingStatus(true)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            )}
          </div>}

          <div>
            {editingTitle ? (
              <input
                ref={titleInputRef}
                className={styles.titleInput}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={handleTitleBlur}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleTitleBlur();
                }}
                autoFocus
              />
            ) : (
              <h2
                className={styles.titleInput}
                onClick={() => {
                  if (!canEdit) return;
                  setEditingTitle(true);
                  setTimeout(() => titleInputRef.current?.focus(), 0);
                }}
                style={{ cursor: canEdit ? 'text' : 'default' }}
              >
                {currentTask.title}
              </h2>
            )}
          </div>

          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Priority</span>
            <div style={{ position: 'relative' }}>
              <span
                className={styles.priorityBadge}
                style={{ color: getPriorityColor(currentTask.priority) }}
                onClick={() => canEdit && setShowPriorityDropdown(!showPriorityDropdown)}
              >
                <span className={styles.priorityDot} style={{ backgroundColor: getPriorityColor(currentTask.priority) }} />
                {TASK_PRIORITY_OPTIONS.find((p) => p.value === currentTask.priority)?.label ?? 'None'}
              </span>
              {showPriorityDropdown && (
                <div className={styles.dropdown}>
                  {TASK_PRIORITY_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`${styles.dropdownOption} ${currentTask.priority === option.value ? styles.dropdownOptionActive : ''}`}
                      onClick={() => handlePriorityChange(option.value)}
                    >
                      <span
                        className={styles.priorityDot}
                        style={{ backgroundColor: option.color }}
                      />
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className={styles.fieldRow} data-date-row>
            <span className={styles.fieldLabel}>Due Date</span>
            {editingDueDate ? (
              <div className={styles.dateEditor}>
                <input
                  ref={dueDateInputRef}
                  className={styles.dateInput}
                  type={dueDateAllDay ? 'date' : 'datetime-local'}
                  value={dueDateAllDay ? dueDateValue.split('T')[0] : dueDateValue}
                  onChange={(e) => setDueDateValue(normalizeDateValue(e.target.value))}
                  onBlur={(e) => {
                    if (!e.currentTarget.closest('[data-date-row]')?.contains(e.relatedTarget as Node)) {
                      handleDueDateBlur();
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleDueDateBlur();
                    if (e.key === 'Escape') setEditingDueDate(false);
                  }}
                  autoFocus
                />
                {currentTask.due_date && (
                  <button type="button" className={styles.dateClear} onClick={handleDueDateClear}>
                    Clear
                  </button>
                )}
              </div>
            ) : (
              <span
                className={styles.fieldValue}
                onClick={() => canEdit && startEditingDueDate()}
                style={{ cursor: canEdit ? 'text' : 'default' }}
              >
                {currentTask.due_date
                  ? dueDateAllDay
                    ? formatDateOnly(currentTask.due_date)
                    : formatDateTime(currentTask.due_date)
                  : <span style={{ color: 'var(--color-text-muted)' }}>No due date</span>}
              </span>
            )}
            <Switch
              label="All day"
              checked={dueDateAllDay}
              onChange={(e) => canEdit && handleDueDateAllDayChange(e.target.checked)}
            />
          </div>

          <div className={styles.fieldRow} data-date-row>
            <span className={styles.fieldLabel}>Start Date</span>
            {editingStartDate ? (
              <div className={styles.dateEditor}>
                <input
                  ref={startDateInputRef}
                  className={styles.dateInput}
                  type={startDateAllDay ? 'date' : 'datetime-local'}
                  value={startDateAllDay ? startDateValue.split('T')[0] : startDateValue}
                  onChange={(e) => setStartDateValue(normalizeDateValue(e.target.value))}
                  onBlur={(e) => {
                    if (!e.currentTarget.closest('[data-date-row]')?.contains(e.relatedTarget as Node)) {
                      handleStartDateBlur();
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleStartDateBlur();
                    if (e.key === 'Escape') setEditingStartDate(false);
                  }}
                  autoFocus
                />
                {currentTask.start_date && (
                  <button type="button" className={styles.dateClear} onClick={handleStartDateClear}>
                    Clear
                  </button>
                )}
              </div>
            ) : (
              <span
                className={styles.fieldValue}
                onClick={() => canEdit && startEditingStartDate()}
                style={{ cursor: canEdit ? 'text' : 'default' }}
              >
                {currentTask.start_date
                  ? startDateAllDay
                    ? formatDateOnly(currentTask.start_date)
                    : formatDateTime(currentTask.start_date)
                  : <span style={{ color: 'var(--color-text-muted)' }}>No start date</span>}
              </span>
            )}
            <Switch
              label="All day"
              checked={startDateAllDay}
              onChange={(e) => canEdit && handleStartDateAllDayChange(e.target.checked)}
            />
          </div>

          {currentTask.message_id && (
            <div className={styles.fieldRow}>
              <span className={styles.fieldLabel}>Source</span>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  const el = document.getElementById(`message-${currentTask.message_id}`);
                  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                </svg>
                Jump to message
              </button>
            </div>
          )}

          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>Description</span>
            </div>
            {editingDescription ? (
              <textarea
                ref={descInputRef}
                className={styles.descriptionArea}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={handleDescriptionBlur}
                rows={6}
                autoFocus
              />
            ) : (
              <div
                className={`${styles.descriptionArea} ${!description ? styles.descriptionEmpty : ''}`}
                onClick={() => {
                  if (!canEdit) return;
                  setEditingDescription(true);
                  setTimeout(() => descInputRef.current?.focus(), 0);
                }}
                style={{ cursor: canEdit ? 'text' : 'default' }}
              >
                {description || 'Click to add a description...'}
              </div>
            )}
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>Assignees</span>
              {canEdit && (
                <button
                  type="button"
                  className={styles.headerButton}
                  onClick={() => setShowAssigneeDropdown(!showAssigneeDropdown)}
                  title="Assign member"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              )}
            </div>
            <div className={styles.sectionContent}>
              {assignees.map((assignee) => (
                <div key={assignee.id} className={styles.assigneeChip}>
                  <Avatar
                    src={assignee.avatar_url ?? undefined}
                    name={assignee.display_name ?? assignee.username ?? assignee.email}
                    size="xs"
                  />
                  <span className={styles.assigneeInfo}>
                    <span className={styles.assigneeName}>{assignee.display_name ?? assignee.username ?? assignee.email}</span>
                    {assignee.email && (
                      <span className={styles.assigneeEmail}>{assignee.email}</span>
                    )}
                  </span>
                  {canEdit && userId !== assignee.id && (
                    <button
                      type="button"
                      className={styles.removeButton}
                      onClick={() => handleUnassign(assignee.id)}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
              {assignees.length === 0 && (
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>
                  No assignees
                </span>
              )}
              {showAssigneeDropdown && (
                <div className={styles.dropdown}>
                  {unassignedMembers.length > 0 ? unassignedMembers.map((member) => (
                    <button
                      key={member.id}
                      type="button"
                      className={styles.dropdownOption}
                      onClick={() => handleAssign(member.id)}
                    >
                      <Avatar
                        src={member.avatar_url ?? undefined}
                        name={member.display_name ?? member.username ?? member.email}
                        size="xs"
                      />
                      {member.display_name ?? member.username ?? member.email}
                    </button>
                  )) : (
                    <span style={{ padding: 'var(--space-2) var(--space-3)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>
                      All members assigned
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>Labels</span>
              {canEdit && (
                <button
                  type="button"
                  className={styles.addLabelButton}
                  onClick={() => setShowLabelDropdown((prev) => !prev)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              )}
            </div>
            <div className={styles.sectionContent}>
              {allLabels.filter((l) => taskLabelIds.includes(l.id)).map((label) => (
                <span
                  key={label.id}
                  className={styles.labelChip}
                  style={{
                    backgroundColor: `${label.color}22`,
                    color: label.color,
                  }}
                >
                  <span className={styles.labelDot} style={{ backgroundColor: label.color }} />
                  {label.name}
                </span>
              ))}
              {allLabels.filter((l) => taskLabelIds.includes(l.id)).length === 0 && !showLabelDropdown && (
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>
                  No labels
                </span>
              )}

              {showLabelDropdown && (
                <div className={styles.labelDropdown}>
                  <div className={styles.labelList}>
                    {allLabels.map((label) => (
                      <button
                        key={label.id}
                        type="button"
                        className={`${styles.labelOption} ${taskLabelIds.includes(label.id) ? styles.labelOptionActive : ''}`}
                        onClick={() => handleToggleLabel(label.id)}
                      >
                        <span className={styles.labelDot} style={{ backgroundColor: label.color }} />
                        {label.name}
                        {taskLabelIds.includes(label.id) && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 'auto' }}>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className={styles.labelCreate}>
                    <input
                      type="text"
                      className={styles.labelNameInput}
                      placeholder="New label..."
                      value={newLabelName}
                      onChange={(e) => setNewLabelName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleCreateLabel(); }}
                    />
                    <input
                      type="color"
                      className={styles.labelColorPicker}
                      value={newLabelColor}
                      onChange={(e) => setNewLabelColor(e.target.value)}
                    />
                    <button
                      type="button"
                      className={styles.labelCreateBtn}
                      onClick={handleCreateLabel}
                      disabled={!newLabelName.trim()}
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <TaskActivity taskId={currentTask.id} />

          <TaskComments taskId={currentTask.id} />
        </div>

        <div className={styles.panelFooter}>
          {canEdit && (
            <button
              type="button"
              className={styles.dangerButton}
              onClick={() => setShowDeleteConfirm(true)}
            >
              Delete Task
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete task"
        message="This action cannot be undone. The task, its comments, and all related data will be permanently removed."
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onClose={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
