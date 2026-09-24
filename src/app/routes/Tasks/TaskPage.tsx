import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useTasks } from '@/hooks/useTasks';
import { supabase } from '@/lib/supabase';
import { TaskList } from '@/components/tasks/TaskList';
import { TaskBoard } from '@/components/tasks/TaskBoard';
import { TaskDialog } from '@/components/tasks/TaskDialog';
import { TaskDetail } from '@/components/tasks/TaskDetail';
import { TaskViewToggle } from '@/components/tasks/TaskViewToggle';
import { Spinner } from '@/components/ui/Spinner';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import type { Task, TaskStatus, TaskPriority } from '@/types/task';
import { TASK_STATUS_OPTIONS, TASK_PRIORITY_OPTIONS } from '@/types/task';
import styles from './TaskPage.module.css';

export function TaskPage() {
  const { currentWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const { taskId } = useParams<{ taskId: string }>();
  const {
    tasks,
    isLoading,
    error,
    refetch,
    setFilters,
    updateTaskStatus,
    updateTask,
    deleteTask,
    archiveTask,
    restoreTask,
    duplicateTask,
  } = useTasks();

  const [view, setView] = useState<'list' | 'board'>('board');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [customStatusesVersion, setCustomStatusesVersion] = useState(0);
  const [customStatusOptions, setCustomStatusOptions] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    if (tasks.length === 0) {
      setCustomStatusOptions([]);
      return;
    }
    let cancelled = false;
    const taskIds = tasks.map((t) => t.id);
    supabase
      .from('task_custom_statuses' as any)
      .select('id, name')
      .in('task_id', taskIds)
      .order('sort_order')
      .then(({ data }) => {
        if (cancelled || !data) return;
        const seen = new Map<string, string>();
        for (const cs of data as unknown as { id: string; name: string }[]) {
          if (cs.name?.startsWith('__hidden__:')) continue;
          if (!seen.has(cs.id)) seen.set(cs.id, cs.name);
        }
        setCustomStatusOptions([...seen.entries()].map(([value, label]) => ({ value, label })));
      });
    return () => {
      cancelled = true;
    };
  }, [tasks, customStatusesVersion]);

  const handleCustomStatusesChange = useCallback(() => {
    setCustomStatusesVersion((v) => v + 1);
  }, []);

  const handleViewChange = useCallback((newView: 'list' | 'board') => {
    setView(newView);
  }, []);

  const handleStatusFilter = useCallback(
    (value: string) => {
      setStatusFilter(value);
      setFilters({
        status: (value as TaskStatus) || undefined,
        priority: (priorityFilter as TaskPriority) || undefined,
        search: searchQuery || undefined,
        includeArchived: showArchived || undefined,
      });
    },
    [priorityFilter, searchQuery, showArchived, setFilters],
  );

  const handlePriorityFilter = useCallback(
    (value: string) => {
      setPriorityFilter(value);
      setFilters({
        status: (statusFilter as TaskStatus) || undefined,
        priority: (value as TaskPriority) || undefined,
        search: searchQuery || undefined,
        includeArchived: showArchived || undefined,
      });
    },
    [statusFilter, searchQuery, showArchived, setFilters],
  );

  const handleSearch = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setSearchQuery(value);
      setFilters({
        status: (statusFilter as TaskStatus) || undefined,
        priority: (priorityFilter as TaskPriority) || undefined,
        search: value || undefined,
        includeArchived: showArchived || undefined,
      });
    },
    [statusFilter, priorityFilter, showArchived, setFilters],
  );

  const handleToggleArchived = useCallback(() => {
    const next = !showArchived;
    setShowArchived(next);
    setFilters({
      status: (statusFilter as TaskStatus) || undefined,
      priority: (priorityFilter as TaskPriority) || undefined,
      search: searchQuery || undefined,
      includeArchived: next || undefined,
    });
  }, [showArchived, statusFilter, priorityFilter, searchQuery, setFilters]);

  const handleRestore = useCallback(
    async (task: Task) => {
      const ok = await restoreTask(task.id);
      if (ok) refetch();
    },
    [restoreTask, refetch],
  );

  const handleTaskClick = useCallback((task: Task) => {
    setSelectedTask(task);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedTask(null);
    if (taskId) navigate('/tasks', { replace: true });
  }, [taskId, navigate]);

  useEffect(() => {
    if (!taskId) return;
    const task = tasks.find((t) => t.id === taskId);
    if (task) setSelectedTask(task);
  }, [taskId, tasks]);

  if (!currentWorkspace) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>Select a workspace to manage tasks</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h2 className={styles.pageTitle}>Tasks</h2>
        <div className={styles.headerActions}>
          <div className={styles.viewToggle}>
            <TaskViewToggle view={view} onChange={handleViewChange} />
          </div>
          <button
            type="button"
            className={styles.createButton}
            onClick={() => setShowCreateDialog(true)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Task
          </button>
        </div>
      </div>

      <div className={styles.filterBar}>
        <div className={styles.searchInput}>
          <Input
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={handleSearch}
          />
        </div>
        <div className={styles.filterSelect}>
          <Select
            options={[
              { value: '', label: 'All Statuses' },
              ...TASK_STATUS_OPTIONS,
              ...customStatusOptions,
            ]}
            value={statusFilter}
            onChange={(e) => handleStatusFilter(e.target.value)}
          />
        </div>
        <div className={styles.filterSelect}>
          <Select
            options={[
              { value: '', label: 'All Priorities' },
              ...TASK_PRIORITY_OPTIONS.map((p) => ({ value: p.value, label: p.label })),
            ]}
            value={priorityFilter}
            onChange={(e) => handlePriorityFilter(e.target.value)}
          />
        </div>
        <label className={styles.archivedToggle}>
          <Switch
            checked={showArchived}
            onChange={handleToggleArchived}
          />
          Archived
        </label>
      </div>

      <div className={styles.content}>
        {isLoading ? (
          <div className={styles.loadingState}>
            <Spinner size="lg" label="Loading tasks..." />
          </div>
        ) : error ? (
          <div className={styles.errorState}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <p>{error}</p>
            <button type="button" className={styles.errorRetry} onClick={refetch}>
              Retry
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <div className={styles.emptyState}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
              <rect x="9" y="3" width="6" height="4" rx="1" />
              <path d="M9 14l2 2 4-4" />
            </svg>
            <p className={styles.emptyTitle}>No tasks yet</p>
            <p className={styles.emptyDescription}>
              Create your first task to get started with project management.
            </p>
            <button
              type="button"
              className={styles.createButton}
              onClick={() => setShowCreateDialog(true)}
            >
              Create Task
            </button>
          </div>
        ) : view === 'list' ? (
          <TaskList tasks={tasks} onTaskClick={handleTaskClick} onRestore={showArchived ? handleRestore : undefined} customStatusesVersion={customStatusesVersion} />
        ) : (
          <TaskBoard tasks={tasks} onTaskClick={handleTaskClick} onStatusChange={updateTaskStatus} onRestore={showArchived ? handleRestore : undefined} onDuplicate={duplicateTask} customStatusesVersion={customStatusesVersion} />
        )}
      </div>

      <TaskDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        workspaceId={currentWorkspace.id}
      />

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={handleCloseDetail}
          onUpdate={updateTask}
          onDelete={deleteTask}
          onArchive={archiveTask}
          onRestore={async (id) => {
            const ok = await restoreTask(id);
            if (ok) refetch();
            return ok;
          }}
          onStatusChange={updateTaskStatus}
          onCustomStatusesChange={handleCustomStatusesChange}
          onTaskUpdated={(updated) => {
            setSelectedTask(updated);
            refetch();
          }}
        />
      )}

    </div>
  );
}
