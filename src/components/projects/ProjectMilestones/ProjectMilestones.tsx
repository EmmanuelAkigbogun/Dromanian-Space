import { useState, useEffect, useCallback, useMemo } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Progress } from '@/components/ui/Progress';
import { Spinner } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { calculateTaskProgress, calculateCompletedTaskCount } from '@/lib/tasks/progress';
import { useToast } from '@/components/ui/Toast';
import { formatRelativeTime } from '@/utils';
import { getStatusColor, type TaskStatus } from '@/types/task';
import type { ProjectMilestone, ProjectMilestoneStatus } from '@/types';
import styles from './ProjectMilestones.module.css';

interface ProjectMilestonesProps {
  projectId: string;
  canEdit?: boolean;
  canCreate?: boolean;
}

interface MilestoneTask {
  id: string;
  title: string;
  status: string;
  status_order: string[] | null;
  milestone_id: string | null;
}

interface MilestoneWithProgress extends ProjectMilestone {
  totalTasks: number;
  completedTasks: number;
  taskStatuses: Array<{ status: string; status_order: string[] | null }>;
  linkedTasks: MilestoneTask[];
}

export function ProjectMilestones({ projectId, canEdit = true, canCreate = true }: ProjectMilestonesProps) {
  const { toast } = useToast();
  const { userId } = useAuth();
  const [milestones, setMilestones] = useState<MilestoneWithProgress[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingMilestone, setEditingMilestone] = useState<ProjectMilestone | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [status, setStatus] = useState<ProjectMilestoneStatus>('active');
  const [isSaving, setIsSaving] = useState(false);
  const [allTasks, setAllTasks] = useState<MilestoneTask[]>([]);
  const [pickerMilestone, setPickerMilestone] = useState<MilestoneWithProgress | null>(null);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [isPicking, setIsPicking] = useState(false);
  const [deletingMilestoneId, setDeletingMilestoneId] = useState<string | null>(null);

  const fetchMilestones = useCallback(async () => {
    setIsLoading(true);

    const { data: milestoneData, error } = await supabase
      .from('project_milestones')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error || !milestoneData) {
      setMilestones([]);
      setIsLoading(false);
      return;
    }

    let tasks: MilestoneTask[] = [];
    const { data: taskData } = await supabase
      .from('tasks')
      .select('id, title, status, milestone_id, status_order')
      .eq('project_id', projectId)
      .is('archived_at', null);
    if (taskData) {
      tasks = taskData as MilestoneTask[];
    }
    setAllTasks(tasks);

    const tasksByMilestone = new Map<string, MilestoneTask[]>();
    for (const task of tasks) {
      if (!task.milestone_id) continue;
      const grouped = tasksByMilestone.get(task.milestone_id) ?? [];
      grouped.push(task);
      tasksByMilestone.set(task.milestone_id, grouped);
    }

    const milestonesWithProgress = milestoneData.map((ms) => {
      const msTasks = tasksByMilestone.get(ms.id) ?? [];
      return {
        ...ms,
        totalTasks: msTasks.length,
        completedTasks: calculateCompletedTaskCount(msTasks),
        taskStatuses: msTasks.map((t) => ({ status: t.status, status_order: t.status_order })),
        linkedTasks: msTasks,
      };
    });

    setMilestones(milestonesWithProgress as unknown as MilestoneWithProgress[]);
    setIsLoading(false);
  }, [projectId]);

  useEffect(() => {
    fetchMilestones();
  }, [fetchMilestones]);

  useEffect(() => {
    if (!projectId) return;
    const channel = supabase
      .channel(`project-milestones-${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projectId}` },
        () => fetchMilestones(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'project_milestones', filter: `project_id=eq.${projectId}` },
        () => fetchMilestones(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, fetchMilestones]);

  const openCreateDialog = useCallback(() => {
    setEditingMilestone(null);
    setTitle('');
    setDescription('');
    setDueDate('');
    setStatus('active');
    setIsDialogOpen(true);
  }, []);

  const openEditDialog = useCallback((ms: MilestoneWithProgress) => {
    setEditingMilestone(ms);
    setTitle(ms.title);
    setDescription(ms.description || '');
    setDueDate(ms.due_date ? ms.due_date.split('T')[0] : '');
    setStatus(ms.status);
    setIsDialogOpen(true);
  }, []);

  const milestoneNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const ms of milestones) map.set(ms.id, ms.title);
    return map;
  }, [milestones]);

  const openPicker = useCallback((ms: MilestoneWithProgress) => {
    setPickerMilestone(ms);
    setPickedIds(new Set(ms.linkedTasks.map((t) => t.id)));
  }, []);

  const togglePicked = useCallback((id: string) => {
    setPickedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSavePicked = useCallback(async () => {
    if (!pickerMilestone) return;
    setIsPicking(true);
    const milestoneId = pickerMilestone.id;
    const currentIds = new Set(pickerMilestone.linkedTasks.map((t) => t.id));
    const toAssign = [...pickedIds].filter((id) => !currentIds.has(id));
    const toRemove = [...currentIds].filter((id) => !pickedIds.has(id));

    try {
      if (toAssign.length > 0) {
        const { error } = await supabase
          .from('tasks')
          .update({ milestone_id: milestoneId, updated_at: new Date().toISOString() })
          .in('id', toAssign);
        if (error) throw error;
      }
      if (toRemove.length > 0) {
        const { error } = await supabase
          .from('tasks')
          .update({ milestone_id: null, updated_at: new Date().toISOString() })
          .in('id', toRemove);
        if (error) throw error;
      }
      setPickerMilestone(null);
      toast({ description: 'Milestone tasks updated', variant: 'success' });
      fetchMilestones();
    } catch {
      toast({ description: 'Failed to update milestone tasks', variant: 'error' });
    } finally {
      setIsPicking(false);
    }
  }, [pickerMilestone, pickedIds, fetchMilestones, toast]);

  const handleSave = useCallback(async () => {
    if (!title.trim()) return;

    setIsSaving(true);
    try {
      if (editingMilestone) {
        const { error } = await supabase
          .from('project_milestones')
          .update({
            title: title.trim(),
            description: description.trim() || null,
            due_date: dueDate || null,
            status,
            updated_at: new Date().toISOString(),
          })
          .eq('id', editingMilestone.id);

        if (error) throw error;
        toast({ description: 'Milestone updated', variant: 'success' });
      } else {
        const { error } = await supabase
          .from('project_milestones')
          .insert({
            project_id: projectId,
            created_by: userId,
            title: title.trim(),
            description: description.trim() || null,
            due_date: dueDate || null,
            status,
          });

        if (error) throw error;
        toast({ description: 'Milestone created', variant: 'success' });
      }

      setIsDialogOpen(false);
      fetchMilestones();
    } catch {
      toast({ description: 'Failed to save milestone', variant: 'error' });
    } finally {
      setIsSaving(false);
    }
  }, [title, description, dueDate, status, editingMilestone, projectId, userId, fetchMilestones, toast]);

  const handleDelete = useCallback((milestoneId: string) => {
    setDeletingMilestoneId(milestoneId);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deletingMilestoneId) return;

    const { error } = await supabase
      .from('project_milestones')
      .delete()
      .eq('id', deletingMilestoneId);

    setDeletingMilestoneId(null);

    if (error) {
      toast({ description: 'Failed to delete milestone', variant: 'error' });
      return;
    }

    toast({ description: 'Milestone deleted', variant: 'success' });
    fetchMilestones();
  }, [deletingMilestoneId, fetchMilestones, toast]);

  const handleDuplicateMilestone = useCallback(async (ms: MilestoneWithProgress) => {
    const { error } = await supabase.from('project_milestones').insert({
      project_id: projectId,
      created_by: userId,
      title: ms.title,
      description: ms.description || null,
      due_date: ms.due_date || null,
      status: ms.status,
    });

    if (error) {
      toast({ description: 'Failed to duplicate milestone', variant: 'error' });
      return;
    }

    toast({ description: 'Milestone duplicated', variant: 'success' });
    fetchMilestones();
  }, [projectId, userId, fetchMilestones, toast]);

  if (isLoading && milestones.length === 0) {
    return (
      <div className={styles.loading}>
        <Spinner size="md" label="Loading milestones..." />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h3 className={styles.title}>Milestones</h3>
        {canCreate && (
          <Button size="sm" onClick={openCreateDialog}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 'var(--space-1)' }}>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Milestone
          </Button>
        )}
      </div>

      {milestones.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyText}>No milestones yet. Create one to track progress.</p>
        </div>
      ) : (
        <div className={styles.list}>
          {milestones.map((ms) => {
            const progress = calculateTaskProgress(ms.taskStatuses);
            const isOverdue = ms.due_date && new Date(ms.due_date) < new Date() && ms.status === 'active';
            const canManageItem = canEdit || ms.created_by === userId;

            return (
              <div key={ms.id} className={styles.milestoneCard}>
                <div className={styles.milestoneHeader}>
                  <div className={styles.milestoneInfo}>
                    <h4 className={styles.milestoneTitle}>{ms.title}</h4>
                    {ms.description && (
                      <p className={styles.milestoneDesc}>{ms.description}</p>
                    )}
                  </div>
                  <div className={styles.milestoneActions}>
                    <Badge
                      variant={
                        ms.status === 'completed' ? 'success'
                        : ms.status === 'cancelled' ? 'error'
                        : isOverdue ? 'warning'
                        : 'info'
                      }
                      size="sm"
                    >
                      {ms.status === 'active' && isOverdue ? 'Overdue' : ms.status}
                    </Badge>
                    {canManageItem && (
                      <button type="button" className={styles.manageBtn} onClick={() => openPicker(ms)}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="8" y1="6" x2="21" y2="6" />
                          <line x1="8" y1="12" x2="21" y2="12" />
                          <line x1="8" y1="18" x2="21" y2="18" />
                          <line x1="3" y1="6" x2="3.01" y2="6" />
                          <line x1="3" y1="12" x2="3.01" y2="12" />
                          <line x1="3" y1="18" x2="3.01" y2="18" />
                        </svg>
                        Tasks
                      </button>
                    )}
                    {canManageItem && (
                      <button type="button" className={styles.duplicateBtn} onClick={() => handleDuplicateMilestone(ms)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                        </svg>
                      </button>
                    )}
                    {canManageItem && (
                      <button type="button" className={styles.editBtn} onClick={() => openEditDialog(ms)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                    )}
                    {canManageItem && (
                      <button type="button" className={styles.deleteBtn} onClick={() => handleDelete(ms.id)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>

                <div className={styles.milestoneMeta}>
                  {ms.due_date && (
                    <span className={`${styles.dueDate} ${isOverdue ? styles.overdue : ''}`}>
                      Due {formatRelativeTime(ms.due_date)}
                    </span>
                  )}
                  {ms.totalTasks > 0 && (
                    <span className={styles.taskProgress}>
                      {ms.completedTasks}/{ms.totalTasks} tasks
                    </span>
                  )}
                </div>

                {ms.totalTasks > 0 && (
                  <Progress value={progress} size="sm" />
                )}

                {ms.linkedTasks.length > 0 && (
                  <div className={styles.taskList}>
                    {ms.linkedTasks.map((t) => (
                      <div key={t.id} className={styles.taskRow}>
                        <span
                          className={styles.taskDot}
                          style={{ backgroundColor: getStatusColor(t.status as TaskStatus) }}
                        />
                        <span className={styles.taskTitle}>{t.title}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
        title={editingMilestone ? 'Edit Milestone' : 'Create Milestone'}
        size="sm"
        footer={
          <div className={styles.dialogFooter}>
            <Button variant="ghost" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} loading={isSaving}>
              {editingMilestone ? 'Save Changes' : 'Create'}
            </Button>
          </div>
        }
      >
        <div className={styles.dialogForm}>
          <Input
            label="Title"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Phase 1 Launch"
            autoFocus
          />
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this milestone represent?"
            rows={3}
          />
          <Input
            label="Due Date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
          <div className={styles.statusSelect}>
            <label className={styles.statusLabel}>Status</label>
            <div className={styles.statusOptions}>
              {(['active', 'completed', 'cancelled'] as ProjectMilestoneStatus[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`${styles.statusOption} ${status === s ? styles.statusOptionActive : ''}`}
                  onClick={() => setStatus(s)}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={pickerMilestone !== null}
        onClose={() => setPickerMilestone(null)}
        title={pickerMilestone ? `Tasks in "${pickerMilestone.title}"` : 'Milestone tasks'}
        size="md"
        footer={
          <div className={styles.dialogFooter}>
            <Button variant="ghost" onClick={() => setPickerMilestone(null)}>Cancel</Button>
            <Button onClick={handleSavePicked} loading={isPicking}>Save</Button>
          </div>
        }
      >
        <div className={styles.pickerList}>
          {allTasks.length === 0 && (
            <p className={styles.pickerEmpty}>
              No tasks in this project yet. Create tasks on the Board or List tab first.
            </p>
          )}
          {allTasks.map((t) => {
            const checked = pickedIds.has(t.id);
            const otherMilestoneId =
              t.milestone_id && t.milestone_id !== pickerMilestone?.id ? t.milestone_id : null;
            const otherMilestoneName = otherMilestoneId ? milestoneNameById.get(otherMilestoneId) : null;
            const disabled = Boolean(otherMilestoneId);
            return (
              <label
                key={t.id}
                className={`${styles.pickerRow} ${disabled ? styles.pickerRowDisabled : ''}`}
              >
                <input
                  type="checkbox"
                  className={styles.pickerCheckbox}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => togglePicked(t.id)}
                />
                <span className={styles.pickerTitle}>{t.title}</span>
                {otherMilestoneName && (
                  <span className={styles.pickerNote}>in {otherMilestoneName}</span>
                )}
              </label>
            );
          })}
        </div>
      </Dialog>

      <ConfirmDialog
        open={deletingMilestoneId !== null}
        title="Delete milestone"
        message="This milestone will be permanently removed. Its tasks are not deleted, but they will no longer be part of this milestone."
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onClose={() => setDeletingMilestoneId(null)}
      />
    </div>
  );
}
