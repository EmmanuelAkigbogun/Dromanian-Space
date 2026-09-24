import { useState, useEffect, useCallback, useMemo } from 'react';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import { calculateTaskProgress, calculateCompletedTaskCount } from '@/lib/tasks/progress';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { TaskDialog } from '@/components/tasks/TaskDialog';
import type { ProjectColumn, ProjectStats, Task, TaskStatus } from '@/types';
import { TASK_STATUS_OPTIONS, TASK_PRIORITY_OPTIONS } from '@/types';
import { formatRelativeTime } from '@/utils';
import styles from './ProjectListView.module.css';

interface ProjectListViewProps {
  projectId: string;
  workspaceId: string;
  columns: ProjectColumn[];
  onStatsChange?: (stats: ProjectStats) => void;
  onTaskDuplicate?: (task: Task) => void;
  customStatusesVersion?: number;
  taskVersion?: number;
  canEdit?: boolean;
  canCreate?: boolean;
}

interface TaskRow extends Task {
  assignees?: Array<{ user_id: string; display_name: string | null; avatar_url: string | null; email?: string | null }>;
  labels?: Array<{ id: string; name: string; color: string }>;
}

type SortField = 'title' | 'status' | 'priority' | 'due_date' | 'created_at';
type SortDirection = 'asc' | 'desc';

export function ProjectListView({ projectId, workspaceId, onStatsChange, onTaskDuplicate, customStatusesVersion = 0, taskVersion = 0, canEdit = true, canCreate = true }: ProjectListViewProps) {
  const { toast } = useToast();
  const { userId } = useAuth();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [taskCustomStatuses, setTaskCustomStatuses] = useState<Record<string, { id: string; name: string }[]>>({});
  const [hiddenStatuses, setHiddenStatuses] = useState<Record<string, string[]>>({});

  const fetchTasks = useCallback(async () => {
    const { data: taskData, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('project_id', projectId)
      .is('archived_at', null);

    if (error || !taskData) return;

    const taskIds = taskData.map((t: any) => t.id);

    let assigneeMap: Record<string, Array<{ user_id: string; display_name: string | null; avatar_url: string | null; email?: string | null }>> = {};
    let labelMap: Record<string, Array<{ id: string; name: string; color: string }>> = {};

    if (taskIds.length > 0) {
      const [assigneeRes, labelRes] = await Promise.all([
        supabase
          .from('task_assignees' as any)
          .select('task_id, user_id, profiles(display_name, avatar_url, email)')
          .in('task_id', taskIds),
        supabase
          .from('task_label_assignments' as any)
          .select('task_id, task_labels(id, name, color)')
          .in('task_id', taskIds),
      ]);

      if (assigneeRes.data) {
        for (const a of assigneeRes.data as any[]) {
          if (!assigneeMap[a.task_id]) assigneeMap[a.task_id] = [];
          assigneeMap[a.task_id].push({
            user_id: a.user_id,
            display_name: a.profiles?.display_name ?? null,
            avatar_url: a.profiles?.avatar_url ?? null,
            email: a.profiles?.email ?? null,
          });
        }
      }

      if (labelRes.data) {
        for (const l of labelRes.data as any[]) {
          if (!labelMap[l.task_id]) labelMap[l.task_id] = [];
          if (l.task_labels) labelMap[l.task_id].push(l.task_labels);
        }
      }
    }

    const mapped = taskData.map((task: any) => ({
      ...task,
      assignees: assigneeMap[task.id] || [],
      labels: labelMap[task.id] || [],
    }));

    setTasks(mapped);

    if (onStatsChange) {
      const totalTasks = mapped.length;
      const taskStatusData = mapped.map((t: any) => ({ status: t.status, status_order: t.status_order }));
      const completedTasks = calculateCompletedTaskCount(taskStatusData);
      const now = new Date();
      const overdueTasks = mapped.filter(
        (t: any) => t.due_date && new Date(t.due_date) < now && t.status !== 'completed',
      ).length;
      onStatsChange({
        total_tasks: totalTasks,
        completed_tasks: completedTasks,
        overdue_tasks: overdueTasks,
        total_members: 0,
        progress: calculateTaskProgress(taskStatusData),
      });
    }
  }, [projectId, onStatsChange, taskVersion]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  useEffect(() => {
    const channel = supabase
      .channel(`project-list-tasks-${projectId}`)
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

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const dir = sortDirection === 'asc' ? 1 : -1;
      switch (sortField) {
        case 'title': return dir * a.title.localeCompare(b.title);
        case 'status': return dir * a.status.localeCompare(b.status);
        case 'priority': return dir * a.priority.localeCompare(b.priority);
        case 'due_date': {
          if (!a.due_date && !b.due_date) return 0;
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          return dir * (new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
        }
        case 'created_at': return dir * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        default: return 0;
      }
    });
  }, [tasks, sortField, sortDirection]);

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  }, [sortField]);

  const statusOptionsFor = useCallback(
    (task: TaskRow): { value: string; label: string }[] => {
      const hidden = hiddenStatuses[task.id] ?? [];
      const defaults = TASK_STATUS_OPTIONS.filter((o) => !hidden.includes(o.value)).map((o) => ({ value: o.value, label: o.label }));
      const customs = (taskCustomStatuses[task.id] ?? [])
        .filter((cs) => !cs.name.startsWith('__hidden__:'))
        .map((cs) => ({ value: cs.id, label: cs.name }));
      const allOptions = [...defaults, ...customs];
      if (task.status_order && task.status_order.length > 0) {
        const optionMap = new Map(allOptions.map((o) => [o.value, o]));
        const ordered = task.status_order.map((id) => optionMap.get(id)).filter(Boolean) as { value: string; label: string }[];
        const missing = allOptions.filter((o) => !ordered.some((r) => r.value === o.value));
        return [...ordered, ...missing];
      }
      return allOptions;
    },
    [hiddenStatuses, taskCustomStatuses],
  );

  const handleStatusChange = useCallback(async (taskId: string, newStatus: TaskStatus) => {
    const { error } = await supabase
      .from('tasks')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', taskId);

    if (error) {
      toast({ description: 'Failed to update status', variant: 'error' });
      return;
    }

    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)));
  }, [toast]);

  const handleToggleSelect = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === sortedTasks.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedTasks.map((t) => t.id)));
    }
  }, [selectedIds.size, sortedTasks]);

  const handleBulkStatusChange = useCallback(async (status: TaskStatus) => {
    if (selectedIds.size === 0) return;

    const ids = Array.from(selectedIds);
    const { error } = await supabase
      .from('tasks')
      .update({ status, updated_at: new Date().toISOString() })
      .in('id', ids);

    if (error) {
      toast({ description: 'Failed to update tasks', variant: 'error' });
      return;
    }

    setTasks((prev) => prev.map((t) => (ids.includes(t.id) ? { ...t, status } : t)));
    setSelectedIds(new Set());
    toast({ description: `${ids.length} tasks updated`, variant: 'success' });
  }, [selectedIds, toast]);

  const SortIcon = ({ field }: { field: SortField }) => (
    <span className={styles.sortIcon}>
      {sortField === field ? (sortDirection === 'asc' ? '\u25B2' : '\u25BC') : '\u25B4'}
    </span>
  );

  return (
    <div className={styles.container}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-3)' }}>
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

      {selectedIds.size > 0 && canEdit && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>{selectedIds.size} selected</span>
          <div className={styles.bulkActions}>
            {TASK_STATUS_OPTIONS.filter((o) => !['completed', 'cancelled'].includes(o.value)).map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={styles.bulkButton}
                onClick={() => handleBulkStatusChange(opt.value as TaskStatus)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <ScrollArea horizontal>
        <table className={styles.table}>
          <thead>
            <tr className={styles.tableHeader}>
              {canEdit && (
                <th className={styles.checkCell}>
                  <Checkbox
                    checked={selectedIds.size === sortedTasks.length && sortedTasks.length > 0}
                    onChange={() => handleSelectAll()}
                  />
                </th>
              )}
              <th className={styles.headerCell} onClick={() => handleSort('title')}>
                Title <SortIcon field="title" />
              </th>
              <th className={styles.headerCell} onClick={() => handleSort('status')}>
                Status <SortIcon field="status" />
              </th>
              <th className={styles.headerCell} onClick={() => handleSort('priority')}>
                Priority <SortIcon field="priority" />
              </th>
              <th className={styles.headerCell}>Assignees</th>
              <th className={styles.headerCell} onClick={() => handleSort('due_date')}>
                Due Date <SortIcon field="due_date" />
              </th>
              <th className={styles.headerCell}>Labels</th>
              {onTaskDuplicate && <th className={styles.headerCell}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {sortedTasks.map((task) => (
              <tr key={task.id} className={styles.tableRow}>
                {canEdit && (
                  <td className={styles.checkCell}>
                    <Checkbox
                      checked={selectedIds.has(task.id)}
                      onChange={() => handleToggleSelect(task.id)}
                    />
                  </td>
                )}
                <td className={styles.titleCell}>{task.title}</td>
                <td className={styles.statusCell}>
                  {canEdit || task.created_by === userId ? (
                    <select
                      className={styles.statusSelect}
                      value={task.status}
                      onChange={(e) => handleStatusChange(task.id, e.target.value as TaskStatus)}
                    >
                      {statusOptionsFor(task).map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <span className={styles.statusText}>{task.status}</span>
                  )}
                </td>
                <td className={styles.priorityCell}>
                  <Badge
                    variant={
                      task.priority === 'urgent' ? 'error'
                      : task.priority === 'high' ? 'warning'
                      : task.priority === 'medium' ? 'info'
                      : task.priority === 'low' ? 'success'
                      : 'default'
                    }
                    size="sm"
                  >
                    {TASK_PRIORITY_OPTIONS.find((o) => o.value === task.priority)?.label || task.priority}
                  </Badge>
                </td>
                <td className={styles.assigneeCell}>
                  <div className={styles.assignees}>
                    {(task.assignees || []).slice(0, 3).map((a) => (
                      <span key={a.user_id} className={styles.assigneeChip}>
                        <Avatar src={a.avatar_url || undefined} name={a.email || a.display_name || '?'} size="xs" />
                        <span className={styles.assigneeEmail} title={a.email || a.display_name || ''}>
                          {a.email || a.display_name || ''}
                        </span>
                      </span>
                    ))}
                    {(task.assignees || []).length > 3 && (
                      <span className={styles.assigneeOverflow}>+{(task.assignees || []).length - 3}</span>
                    )}
                  </div>
                </td>
                <td className={styles.dateCell}>
                  {task.due_date ? (
                    <span className={new Date(task.due_date) < new Date() && task.status !== 'completed' ? styles.overdue : ''}>
                      {formatRelativeTime(task.due_date)}
                    </span>
                  ) : (
                    <span className={styles.noDate}>-</span>
                  )}
                </td>
                <td className={styles.labelCell}>
                  <div className={styles.labels}>
                    {(task.labels || []).map((l) => (
                      <span key={l.id} className={styles.label} style={{ backgroundColor: l.color + '20', color: l.color }}>
                        {l.name}
                      </span>
                    ))}
                  </div>
                </td>
                {onTaskDuplicate && (
                  <td className={styles.actionCell}>
                    <button
                      type="button"
                      className={styles.rowActionBtn}
                      onClick={() => onTaskDuplicate(task)}
                      title="Duplicate task"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>

      {sortedTasks.length === 0 && (
        <div className={styles.emptyState}>
          <p className={styles.emptyText}>No tasks in this project yet.</p>
        </div>
      )}

      {userId && (
        <TaskDialog
          open={isAddDialogOpen}
          onClose={() => {
            setIsAddDialogOpen(false);
            fetchTasks();
          }}
          workspaceId={workspaceId}
          projectId={projectId}
        />
      )}
    </div>
  );
}
