import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/Toast';
import { TaskCard } from '@/components/tasks/TaskCard';
import { TaskDialog } from '@/components/tasks/TaskDialog';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import type { ProjectColumn, Task, TaskStatus } from '@/types';
import styles from './ProjectBoard.module.css';

interface ProjectBoardProps {
  projectId: string;
  workspaceId: string;
  columns: ProjectColumn[];
  onColumnsChange: (columns: ProjectColumn[]) => void;
  onTaskClick?: (task: Task) => void;
  onTaskUpdated?: (taskId: string) => void;
  onTaskDuplicate?: (task: Task) => void;
  customStatusesVersion?: number;
  taskVersion?: number;
  statusOrder?: { id: string; name: string }[] | null;
  canEdit?: boolean;
  canCreate?: boolean;
}

interface TaskWithAssignees extends Task {
  assignees?: Array<{ user_id: string; display_name: string | null; avatar_url: string | null; email?: string | null }>;
}

interface PickerTask {
  id: string;
  title: string;
  project_id: string | null;
}

export function ProjectBoard({ projectId, workspaceId, onTaskClick, onTaskUpdated, onTaskDuplicate, customStatusesVersion = 0, taskVersion = 0, statusOrder = null, canEdit = true, canCreate = true }: ProjectBoardProps) {
  const { toast } = useToast();
  const { userId } = useAuth();
  const [tasks, setTasks] = useState<TaskWithAssignees[]>([]);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [taskCustomStatuses, setTaskCustomStatuses] = useState<Record<string, { id: string; name: string }[]>>({});
  const [hiddenStatuses, setHiddenStatuses] = useState<Record<string, string[]>>({});
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [pickerTasks, setPickerTasks] = useState<PickerTask[]>([]);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [isSavingPicked, setIsSavingPicked] = useState(false);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});

  const fetchTasks = useCallback(async () => {
    const { data: taskData, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('project_id', projectId)
      .is('archived_at', null)
      .order('sort_order')
      .order('created_at')
      .order('id');

    if (error || !taskData) return;

    const taskIds = taskData.map((t: any) => t.id);

    let assigneeMap: Record<string, Array<{ user_id: string; display_name: string | null; avatar_url: string | null; email?: string | null }>> = {};

    if (taskIds.length > 0) {
      const { data: assigneeData } = await supabase
        .from('task_assignees' as any)
        .select('task_id, user_id, profiles(display_name, avatar_url, email)')
        .in('task_id', taskIds);

      if (assigneeData) {
        for (const a of assigneeData as any[]) {
          if (!assigneeMap[a.task_id]) assigneeMap[a.task_id] = [];
          assigneeMap[a.task_id].push({
            user_id: a.user_id,
            display_name: a.profiles?.display_name ?? null,
            avatar_url: a.profiles?.avatar_url ?? null,
            email: a.profiles?.email ?? null,
          });
        }
      }
    }

    setTasks(
      taskData.map((task: any) => ({
        ...task,
        assignees: assigneeMap[task.id] || [],
      })),
    );
  }, [projectId, taskVersion]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  useEffect(() => {
    const channel = supabase
      .channel(`project-board-tasks-${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projectId}` },
        () => fetchTasks(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, fetchTasks]);

  useEffect(() => {
    if (tasks.length === 0) return;
    const loadCustomStatuses = async () => {
      const taskIds = tasks.map((t) => t.id);
      const { data: customStatuses } = await supabase
        .from('task_custom_statuses' as any)
        .select('task_id, id, name')
        .in('task_id', taskIds)
        .order('sort_order');

      if (customStatuses) {
        const csGrouped: Record<string, { id: string; name: string }[]> = {};
        const hiddenGrouped: Record<string, string[]> = {};
        for (const cs of customStatuses as unknown as { task_id: string; id: string; name: string }[]) {
          if (cs.name?.startsWith('__hidden__:')) {
            if (!hiddenGrouped[cs.task_id]) hiddenGrouped[cs.task_id] = [];
            hiddenGrouped[cs.task_id].push(cs.name.replace('__hidden__:', ''));
            continue;
          }
          if (!csGrouped[cs.task_id]) csGrouped[cs.task_id] = [];
          csGrouped[cs.task_id].push({ id: cs.id, name: cs.name });
        }
        setTaskCustomStatuses(csGrouped);
        setHiddenStatuses(hiddenGrouped);
      }
    };
    loadCustomStatuses();
  }, [tasks, customStatusesVersion]);

  const assigneeNamesFor = useCallback((task: { assignees?: Array<{ user_id: string; display_name: string | null; avatar_url: string | null; email?: string | null }> }) => {
    const map: Record<string, { name: string; avatar_url: string | null; email: string | null }> = {};
    for (const a of task.assignees || []) {
      map[a.user_id] = {
        name: a.display_name ?? a.email ?? '?',
        avatar_url: a.avatar_url,
        email: a.email ?? null,
      };
    }
    return map;
  }, []);

  const handleStatusChange = useCallback(async (taskId: string, status: TaskStatus) => {
    const { error } = await supabase
      .from('tasks')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', taskId);

    if (error) {
      toast({ description: 'Failed to update status', variant: 'error' });
      return;
    }

    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status } : t)));
    onTaskUpdated?.(taskId);
  }, [toast, onTaskUpdated]);

  const openPicker = useCallback(async () => {
    setIsPickerOpen(true);
    const [tasksRes, projectsRes] = await Promise.all([
      supabase
        .from('tasks')
        .select('id, title, project_id')
        .eq('workspace_id', workspaceId)
        .is('archived_at', null)
        .order('created_at'),
      supabase.from('projects').select('id, name').eq('workspace_id', workspaceId),
    ]);

    const taskRows = (tasksRes.data ?? []) as PickerTask[];
    setPickerTasks(taskRows);
    setPickedIds(new Set(taskRows.filter((t) => t.project_id === projectId).map((t) => t.id)));

    const names: Record<string, string> = {};
    for (const p of (projectsRes.data ?? []) as { id: string; name: string }[]) {
      names[p.id] = p.name;
    }
    setProjectNames(names);
  }, [workspaceId, projectId]);

  const togglePicked = useCallback((id: string) => {
    setPickedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const savePicked = useCallback(async () => {
    setIsSavingPicked(true);
    const currentIds = new Set(pickerTasks.filter((t) => t.project_id === projectId).map((t) => t.id));
    const toAssign = [...pickedIds].filter((id) => !currentIds.has(id));
    const toRemove = [...currentIds].filter((id) => !pickedIds.has(id));

    try {
      if (toAssign.length > 0) {
        const { error } = await supabase
          .from('tasks')
          .update({ project_id: projectId, updated_at: new Date().toISOString() })
          .in('id', toAssign);
        if (error) throw error;
      }
      if (toRemove.length > 0) {
        const { error } = await supabase
          .from('tasks')
          .update({ project_id: null, updated_at: new Date().toISOString() })
          .in('id', toRemove);
        if (error) throw error;
      }
      setIsPickerOpen(false);
      toast({ description: 'Project tasks updated', variant: 'success' });
      fetchTasks();
    } catch {
      toast({ description: 'Failed to update project tasks', variant: 'error' });
    } finally {
      setIsSavingPicked(false);
    }
  }, [pickerTasks, pickedIds, projectId, fetchTasks, toast]);

  return (
    <div className={styles.wrapper}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
        {canCreate && (
          <Button size="sm" variant="secondary" onClick={openPicker}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 'var(--space-1)' }}>
              <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
              <rect x="9" y="3" width="6" height="4" rx="1" />
              <line x1="9" y1="11" x2="15" y2="11" />
              <line x1="9" y1="15" x2="13" y2="15" />
            </svg>
            Add existing
          </Button>
        )}
        {canCreate && (
          <Button size="sm" onClick={() => setIsAddDialogOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 'var(--space-1)' }}>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Task
          </Button>
        )}
      </div>

      <div className={styles.grid}>
        {tasks.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyText}>No tasks yet</p>
            {canCreate && <Button size="sm" onClick={() => setIsAddDialogOpen(true)}>Add Task</Button>}
          </div>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onClick={onTaskClick}
              onStatusChange={canEdit || task.created_by === userId ? handleStatusChange : undefined}
              onDuplicate={onTaskDuplicate}
              customStatuses={taskCustomStatuses[task.id] ?? []}
              statusOrder={statusOrder}
              hiddenStatuses={hiddenStatuses[task.id] ?? []}
              assigneeNames={assigneeNamesFor(task)}
            />
          ))
        )}

        <TaskDialog
          open={isAddDialogOpen}
          onClose={() => {
            setIsAddDialogOpen(false);
            fetchTasks();
          }}
          workspaceId={workspaceId}
          projectId={projectId}
        />

        <Dialog
          open={isPickerOpen}
          onClose={() => setIsPickerOpen(false)}
          title="Add existing tasks"
          size="md"
          footer={
            <div className={styles.dialogFooter}>
              <Button variant="ghost" onClick={() => setIsPickerOpen(false)}>Cancel</Button>
              <Button onClick={savePicked} loading={isSavingPicked}>Save</Button>
            </div>
          }
        >
          <div className={styles.pickerList}>
            {pickerTasks.length === 0 && (
              <p className={styles.pickerEmpty}>
                No tasks in this workspace yet. Create tasks first.
              </p>
            )}
            {pickerTasks.map((t) => {
              const checked = pickedIds.has(t.id);
              const otherProjectId = t.project_id && t.project_id !== projectId ? t.project_id : null;
              const otherProjectName = otherProjectId ? projectNames[otherProjectId] : null;
              const disabled = Boolean(otherProjectId);
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
                  {otherProjectName && (
                    <span className={styles.pickerNote}>in {otherProjectName}</span>
                  )}
                </label>
              );
            })}
          </div>
        </Dialog>
      </div>
    </div>
  );
}
