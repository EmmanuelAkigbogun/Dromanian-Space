import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import { createTypedNotification } from '@/features/notifications/service';
import { resolveTaskStatusLabel } from '@/lib/tasks/status';
import type { UUID } from '@/types';
import type {
  Task,
  TaskStatus,
  TaskPriority,
  TaskComment,
  TaskActivity,
  TaskLabel,
  TaskAssignee,
  TaskLabelAssignment,
} from '@/types/task';

interface TaskFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: UUID;
  search?: string;
  projectId?: UUID;
  includeArchived?: boolean;
}

interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_date?: string;
  start_date?: string;
  assigneeIds?: UUID[];
  labelIds?: UUID[];
  project_id?: UUID;
  linked_message_id?: UUID;
}

interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_date?: string | null;
  start_date?: string | null;
  project_id?: UUID;
}

interface UseTasksReturn {
  tasks: Task[];
  isLoading: boolean;
  error: string | null;
  createTask: (input: CreateTaskInput) => Promise<Task | null>;
  updateTask: (taskId: string, input: UpdateTaskInput) => Promise<boolean>;
  updateTaskStatus: (taskId: string, status: TaskStatus) => Promise<boolean>;
  duplicateTask: (task: Task) => Promise<Task | null>;
  deleteTask: (taskId: string) => Promise<boolean>;
  archiveTask: (taskId: string) => Promise<boolean>;
  restoreTask: (taskId: string) => Promise<boolean>;
  convertMessageToTask: (messageId: string, content: string, options?: Partial<CreateTaskInput>) => Promise<Task | null>;
  refetch: () => Promise<void>;
  getTaskComments: (taskId: string) => Promise<TaskComment[]>;
  addTaskComment: (taskId: string, content: string, parentId?: string) => Promise<TaskComment | null>;
  updateTaskComment: (commentId: string, content: string) => Promise<boolean>;
  deleteTaskComment: (commentId: string) => Promise<boolean>;
  getTaskActivity: (taskId: string) => Promise<TaskActivity[]>;
  assignUser: (taskId: string, userId: UUID) => Promise<boolean>;
  unassignUser: (taskId: string, userId: UUID) => Promise<boolean>;
  getTaskAssignees: (taskId: string) => Promise<TaskAssignee[]>;
  getLabels: () => Promise<TaskLabel[]>;
  createLabel: (name: string, color: string) => Promise<TaskLabel | null>;
  assignLabel: (taskId: string, labelId: string) => Promise<boolean>;
  unassignLabel: (taskId: string, labelId: string) => Promise<boolean>;
  getTaskLabels: (taskId: string) => Promise<TaskLabelAssignment[]>;
  setFilters: (filters: TaskFilters) => void;
}

// Module-level singleton realtime subscription, held while at least one
// useTasks consumer is mounted. Scoped to the current workspace so events for
// other workspaces are dropped by the server before delivery, and so multiple
// useTasks instances share a single channel instead of one per mount.
type TaskRealtimeListener = () => void;
const taskRealtimeListeners = new Set<TaskRealtimeListener>();
let taskRealtimeChannel: ReturnType<typeof supabase.channel> | null = null;
let taskRealtimeWorkspaceId: string | null = null;
let taskRealtimeCount = 0;

function notifyTaskRealtime() {
  taskRealtimeListeners.forEach((fn) => fn());
}

function acquireTaskRealtime(workspaceId: string) {
  taskRealtimeCount += 1;
  if (taskRealtimeChannel && taskRealtimeWorkspaceId === workspaceId) return;
  if (taskRealtimeChannel) {
    supabase.removeChannel(taskRealtimeChannel);
    taskRealtimeChannel = null;
  }
  taskRealtimeWorkspaceId = workspaceId;
  taskRealtimeChannel = supabase
    .channel('tasks-realtime-global')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'tasks', filter: `workspace_id=eq.${workspaceId}` },
      () => notifyTaskRealtime(),
    )
    .subscribe();
}

function releaseTaskRealtime() {
  taskRealtimeCount = Math.max(0, taskRealtimeCount - 1);
  if (taskRealtimeCount === 0 && taskRealtimeChannel) {
    supabase.removeChannel(taskRealtimeChannel);
    taskRealtimeChannel = null;
    taskRealtimeWorkspaceId = null;
  }
}

export function useTasks(filters?: TaskFilters): UseTasksReturn {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilters, setActiveFilters] = useState<TaskFilters>(filters ?? {});
  const filtersRef = useRef(activeFilters);
  filtersRef.current = activeFilters;

  const fetchTasks = useCallback(async () => {
    if (!userId || !currentWorkspace?.id) {
      setTasks([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);

    try {
      let query = supabase
        .from('tasks' as any)
        .select('*')
        .eq('workspace_id', currentWorkspace.id)
        .order('created_at', { ascending: false });

      if (filtersRef.current.includeArchived) {
        query = query.not('archived_at', 'is', null);
      } else {
        query = query.is('archived_at', null);
      }

      const f = filtersRef.current;
      if (f.status) {
        query = query.eq('status', f.status);
      }
      if (f.priority) {
        query = query.eq('priority', f.priority);
      }
      if (f.projectId) {
        query = query.eq('project_id', f.projectId);
      }
      if (f.search) {
        query = query.ilike('title', `%${f.search}%`);
      }

      const { data, error: fetchError } = await query;
      if (fetchError) throw fetchError;

      let result = (data as unknown as Task[]) ?? [];

      if (f.assigneeId) {
        const taskIds = result.map((t) => t.id);
        if (taskIds.length === 0) {
          result = [];
        } else {
          const { data: assignments } = await supabase
            .from('task_assignees' as any)
            .select('task_id')
            .in('task_id', taskIds)
            .eq('user_id', f.assigneeId);

          const assignedIds = new Set((assignments as unknown as TaskAssignee[])?.map((a) => a.task_id) ?? []);
          result = result.filter((t) => assignedIds.has(t.id));
        }
      }

      const otherTaskIds = result
        .filter((t) => t.created_by !== userId)
        .map((t) => t.id);

      let assignedToMeIds = new Set<string>();
      if (otherTaskIds.length > 0) {
        const { data: myAssignments } = await supabase
          .from('task_assignees' as any)
          .select('task_id')
          .eq('user_id', userId)
          .in('task_id', otherTaskIds);
        assignedToMeIds = new Set(((myAssignments || []) as any[]).map((a: any) => a.task_id));
      }

      result = result.filter((t) => {
        if (t.created_by === userId) return true;
        if (assignedToMeIds.has(t.id)) return true;
        return false;
      });

      setTasks(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch tasks');
    } finally {
      setIsLoading(false);
    }
  }, [userId, currentWorkspace?.id]);

  useEffect(() => {
    fetchTasks();
  }, [activeFilters, fetchTasks]);

  const fetchTasksRef = useRef(fetchTasks);
  fetchTasksRef.current = fetchTasks;

  useEffect(() => {
    if (!userId || !currentWorkspace?.id) return;

    acquireTaskRealtime(currentWorkspace.id);
    const listener: TaskRealtimeListener = () => {
      fetchTasksRef.current();
    };
    taskRealtimeListeners.add(listener);

    return () => {
      taskRealtimeListeners.delete(listener);
      releaseTaskRealtime();
    };
  }, [userId, currentWorkspace?.id]);

  const createTask = useCallback(
    async (input: CreateTaskInput): Promise<Task | null> => {
      if (!userId || !currentWorkspace?.id) return null;
      setError(null);

      try {
        const taskData: Record<string, unknown> = {
          workspace_id: currentWorkspace.id,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? 'todo',
          priority: input.priority ?? 'none',
          due_date: input.due_date ?? null,
          start_date: input.start_date ?? null,
          created_by: userId,
          project_id: input.project_id ?? null,
          message_id: input.linked_message_id ?? null,
        };

        if (input.status) {
          taskData.status = input.status;
        }

        const { data, error: createError } = await supabase
          .from('tasks' as any)
          .insert(taskData)
          .select()
          .single();

        if (createError) throw createError;

        const task = data as unknown as Task;

        if (input.assigneeIds && input.assigneeIds.length > 0) {
          const assigneeRows = input.assigneeIds.map((uid) => ({
            task_id: task.id,
            user_id: uid,
          }));
          await supabase.from('task_assignees' as any).insert(assigneeRows);

          const taskWorkspaceId = currentWorkspace?.id || null;
          const link = `/tasks/${task.id}`;
          for (const assigneeId of input.assigneeIds) {
            createTypedNotification(
              assigneeId,
              'system',
              `You were assigned to: ${input.title}`,
              `You have been assigned to the task "${input.title}"`,
              link,
              'tasks',
              'task',
              task.id,
              userId,
              taskWorkspaceId,
            ).catch(() => {});
          }
        }

        if (input.labelIds && input.labelIds.length > 0) {
          const labelRows = input.labelIds.map((labelId) => ({
            task_id: task.id,
            label_id: labelId,
          }));
          await supabase.from('task_label_assignments' as any).insert(labelRows);
        }

        await supabase.from('task_activity' as any).insert({
          task_id: task.id,
          user_id: userId,
          action: 'created',
          description: 'created this task',
        });

        setTasks((prev) => [task, ...prev]);
        return task;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create task');
        return null;
      }
    },
    [userId, currentWorkspace?.id],
  );

  const updateTask = useCallback(
    async (taskId: string, input: UpdateTaskInput): Promise<boolean> => {
      if (!userId) return false;
      setError(null);

      try {
        const { error: updateError } = await supabase
          .rpc('update_task', {
            p_task_id: taskId,
            p_title: input.title ?? null,
            p_description: input.description ?? null,
            p_status: input.status ?? null,
            p_priority: input.priority ?? null,
            p_due_date: input.due_date ?? null,
            p_start_date: input.start_date ?? null,
            p_project_id: input.project_id ?? null,
          });

        if (updateError) throw updateError;

        setTasks((prev) =>
          prev.map((t) => (t.id === taskId ? { ...t, ...input, updated_at: new Date().toISOString() } : t)),
        );

        if (input.status) {
          await supabase.from('task_activity' as any).insert({
            task_id: taskId,
            user_id: userId,
            action: 'status_changed',
            description: `changed status to ${input.status}`,
            new_value: input.status,
          });
          notifyTaskStatusChanged(taskId, input.status, userId).catch(() => {});
        }
        if (input.priority) {
          await supabase.from('task_activity' as any).insert({
            task_id: taskId,
            user_id: userId,
            action: 'priority_changed',
            description: `changed priority to ${input.priority}`,
            new_value: input.priority,
          });
          notifyTaskPriorityChanged(taskId, input.priority, userId).catch(() => {});
        }
        if (input.title || input.description) {
          await supabase.from('task_activity' as any).insert({
            task_id: taskId,
            user_id: userId,
            action: 'edited',
            description: 'edited this task',
          });
          notifyTaskEdited(taskId, userId, input).catch(() => {});
        }

        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update task');
        return false;
      }
    },
    [userId],
  );

  const updateTaskStatus = useCallback(
    async (taskId: string, status: TaskStatus): Promise<boolean> => {
      if (!userId) return false;
      setError(null);

      try {
        const { error: updateError } = await supabase
          .rpc('update_task_status', { p_task_id: taskId, p_status: status });

        if (updateError) throw updateError;

        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId ? { ...t, status, updated_at: new Date().toISOString() } : t,
          ),
        );

        notifyTaskStatusChanged(taskId, status, userId).catch(() => {});

        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update task status');
        return false;
      }
    },
    [userId],
  );

  const duplicateTask = useCallback(
    async (source: Task): Promise<Task | null> => {
      if (!userId || !currentWorkspace?.id) return null;
      setError(null);

      try {
        const taskData: Record<string, unknown> = {
          workspace_id: source.workspace_id,
          title: source.title,
          description: source.description ?? null,
          status: 'todo',
          priority: source.priority ?? 'none',
          due_date: source.due_date ?? null,
          start_date: source.start_date ?? null,
          created_by: userId,
          project_id: source.project_id ?? null,
          column_id: source.column_id ?? null,
          channel_id: source.channel_id ?? null,
          message_id: source.message_id ?? null,
          milestone_id: source.milestone_id ?? null,
          sort_order: source.sort_order ?? 0,
          status_order: source.status_order ?? null,
        };

        const { data, error: createError } = await supabase
          .from('tasks' as any)
          .insert(taskData)
          .select()
          .single();

        if (createError) throw createError;

        const task = data as unknown as Task;

        const [assigneesRes, labelsRes] = await Promise.all([
          supabase.from('task_assignees' as any).select('user_id').eq('task_id', source.id),
          supabase.from('task_label_assignments' as any).select('label_id').eq('task_id', source.id),
        ]);

        const assigneeIds = ((assigneesRes.data || []) as any[]).map((a: any) => a.user_id);
        const labelIds = ((labelsRes.data || []) as any[]).map((l: any) => l.label_id);

        if (assigneeIds.length > 0) {
          await supabase.from('task_assignees' as any).insert(
            assigneeIds.map((uid: string) => ({ task_id: task.id, user_id: uid })),
          );
        }
        if (labelIds.length > 0) {
          await supabase.from('task_label_assignments' as any).insert(
            labelIds.map((labelId: string) => ({ task_id: task.id, label_id: labelId })),
          );
        }

        await supabase.from('task_activity' as any).insert({
          task_id: task.id,
          user_id: userId,
          action: 'created',
          description: 'created this task',
        });

        setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [task, ...prev]));
        return task;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to duplicate task');
        return null;
      }
    },
    [userId, currentWorkspace?.id],
  );

  const deleteTask = useCallback(
    async (taskId: string): Promise<boolean> => {
      if (!userId) return false;
      setError(null);

      try {
        const { error: deleteError } = await supabase
          .rpc('delete_task', { p_task_id: taskId });

        if (deleteError) throw deleteError;
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete task');
        return false;
      }
    },
    [userId],
  );

  const archiveTask = useCallback(
    async (taskId: string): Promise<boolean> => {
      if (!userId) return false;
      setError(null);

      try {
        const { error: archiveError } = await supabase
          .rpc('archive_task', { p_task_id: taskId });

        if (archiveError) throw archiveError;
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to archive task');
        return false;
      }
    },
    [userId],
  );

  const restoreTask = useCallback(
    async (taskId: string): Promise<boolean> => {
      if (!userId) return false;
      setError(null);

      try {
        const { error } = await supabase
          .rpc('restore_task', { p_task_id: taskId });

        if (error) throw error;
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to restore task');
        return false;
      }
    },
    [userId],
  );

  const convertMessageToTask = useCallback(
    async (messageId: string, content: string, options?: Partial<CreateTaskInput>): Promise<Task | null> => {
      return createTask({
        title: content.slice(0, 200),
        description: content,
        linked_message_id: messageId,
        ...options,
      });
    },
    [createTask],
  );

  const getTaskComments = useCallback(async (taskId: string): Promise<TaskComment[]> => {
    const { data, error } = await supabase
      .from('task_comments' as any)
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Failed to fetch task comments:', error);
      return [];
    }

    return (data as unknown as TaskComment[]) ?? [];
  }, []);

  const addTaskComment = useCallback(
    async (taskId: string, content: string, parentId?: string): Promise<TaskComment | null> => {
      if (!userId) return null;

      const { data, error } = await supabase
        .from('task_comments' as any)
        .insert({
          task_id: taskId,
          user_id: userId,
          content,
          parent_id: parentId ?? null,
        })
        .select()
        .single();

      if (error) {
        console.error('Failed to add task comment:', error);
        return null;
      }

      await supabase.from('task_activity' as any).insert({
        task_id: taskId,
        user_id: userId,
        action: 'commented',
        description: 'added a comment',
      });

      return data as unknown as TaskComment;
    },
    [userId],
  );

  const updateTaskComment = useCallback(
    async (commentId: string, content: string): Promise<boolean> => {
      const { error } = await supabase
        .from('task_comments' as any)
        .update({ content, updated_at: new Date().toISOString() })
        .eq('id', commentId);

      return !error;
    },
    [],
  );

  const deleteTaskComment = useCallback(
    async (commentId: string): Promise<boolean> => {
      const { error } = await supabase
        .from('task_comments' as any)
        .delete()
        .eq('id', commentId);

      return !error;
    },
    [],
  );

  const getTaskActivity = useCallback(async (taskId: string): Promise<TaskActivity[]> => {
    const { data, error } = await supabase
      .from('task_activity' as any)
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch task activity:', error);
      return [];
    }

    return (data as unknown as TaskActivity[]) ?? [];
  }, []);

  const assignUser = useCallback(
    async (taskId: string, userIdToAssign: UUID): Promise<boolean> => {
      if (!userId) return false;

      const { error } = await supabase.from('task_assignees' as any).insert({
        task_id: taskId,
        user_id: userIdToAssign,
      });

      if (error) return false;

      await supabase.from('task_activity' as any).insert({
        task_id: taskId,
        user_id: userId,
        action: 'assigned',
        description: 'assigned a member',
        new_value: userIdToAssign,
      });

      const [taskRes, assignerRes] = await Promise.all([
        supabase.from('tasks' as any).select('title, workspace_id').eq('id', taskId).single(),
        supabase.from('profiles' as any).select('display_name, username').eq('id', userId).single(),
      ]);

      const taskRow = taskRes.data as any;
      const assignerRow = assignerRes.data as any;

      if (taskRow) {
        const assignerName = assignerRow?.display_name || assignerRow?.username || 'Someone';
        createTypedNotification(
          userIdToAssign,
          'system',
          `You were assigned to: ${taskRow.title}`,
          `${assignerName} assigned you to the task "${taskRow.title}"`,
          `/tasks/${taskId}`,
          'tasks',
          'task',
          taskId,
          userId,
          taskRow.workspace_id,
        ).catch(() => {});
      }

      return true;
    },
    [userId],
  );

  const unassignUser = useCallback(
    async (taskId: string, userIdToUnassign: UUID): Promise<boolean> => {
      if (!userId) return false;

      const { error } = await supabase
        .from('task_assignees' as any)
        .delete()
        .eq('task_id', taskId)
        .eq('user_id', userIdToUnassign);

      if (error) return false;

      await supabase.from('task_activity' as any).insert({
        task_id: taskId,
        user_id: userId,
        action: 'unassigned',
        description: 'removed a member',
        old_value: userIdToUnassign,
      });

      return true;
    },
    [userId],
  );

  const getTaskAssignees = useCallback(async (taskId: string): Promise<TaskAssignee[]> => {
    const { data, error } = await supabase
      .from('task_assignees' as any)
      .select('*')
      .eq('task_id', taskId);

    if (error) return [];
    return (data as unknown as TaskAssignee[]) ?? [];
  }, []);

  const getLabels = useCallback(async (): Promise<TaskLabel[]> => {
    const { data, error } = await supabase
      .from('task_labels' as any)
      .select('*')
      .order('name', { ascending: true });

    if (error) return [];
    return (data as unknown as TaskLabel[]) ?? [];
  }, []);

  const createLabel = useCallback(
    async (name: string, color: string): Promise<TaskLabel | null> => {
      if (!currentWorkspace?.id) return null;
      const { data, error } = await supabase
        .from('task_labels' as any)
        .insert({ name, color, workspace_id: currentWorkspace.id })
        .select()
        .single();

      if (error) return null;
      return data as unknown as TaskLabel;
    },
    [],
  );

  const assignLabel = useCallback(
    async (taskId: string, labelId: string): Promise<boolean> => {
      const { error } = await supabase.from('task_label_assignments' as any).insert({
        task_id: taskId,
        label_id: labelId,
      });
      return !error;
    },
    [],
  );

  const unassignLabel = useCallback(
    async (taskId: string, labelId: string): Promise<boolean> => {
      const { error } = await supabase
        .from('task_label_assignments' as any)
        .delete()
        .eq('task_id', taskId)
        .eq('label_id', labelId);
      return !error;
    },
    [],
  );

  const getTaskLabels = useCallback(async (taskId: string): Promise<TaskLabelAssignment[]> => {
    const { data, error } = await supabase
      .from('task_label_assignments' as any)
      .select('*')
      .eq('task_id', taskId);

    if (error) return [];
    return (data as unknown as TaskLabelAssignment[]) ?? [];
  }, []);

  const setFilters = useCallback((newFilters: TaskFilters) => {
    setActiveFilters(newFilters);
  }, []);

  async function notifyTaskStatusChanged(
    taskId: string,
    newStatus: TaskStatus,
    actorId: string,
  ) {
    const [taskRes, assigneesRes, actorRes, statusLabel] = await Promise.all([
      supabase.from('tasks' as any).select('title, workspace_id, created_by').eq('id', taskId).single(),
      supabase.from('task_assignees' as any).select('user_id').eq('task_id', taskId),
      supabase.from('profiles' as any).select('display_name, username').eq('id', actorId).single(),
      resolveTaskStatusLabel(newStatus),
    ]);

    const taskRow = taskRes.data as any;
    if (taskRes.error || !taskRow) return;

    const assigneeIds = ((assigneesRes.data || []) as any[])
      .map((a: any) => a.user_id)
      .filter((id: string) => id !== actorId);

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
          actorId,
          taskRow.workspace_id,
        ),
      ),
    );
  }

  async function notifyTaskPriorityChanged(
    taskId: string,
    newPriority: TaskPriority,
    actorId: string,
  ) {
    const [taskRes, assigneesRes, actorRes] = await Promise.all([
      supabase.from('tasks' as any).select('title, workspace_id').eq('id', taskId).single(),
      supabase.from('task_assignees' as any).select('user_id').eq('task_id', taskId),
      supabase.from('profiles' as any).select('display_name, username').eq('id', actorId).single(),
    ]);

    const taskRow = taskRes.data as any;
    if (taskRes.error || !taskRow) return;

    const assigneeIds = ((assigneesRes.data || []) as any[])
      .map((a: any) => a.user_id)
      .filter((id: string) => id !== actorId);

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
          `Task priority changed: ${title}`,
          `${actorName} changed the priority of "${title}" to ${newPriority}`,
          link,
          'tasks',
          'task',
          taskId,
          actorId,
          taskRow.workspace_id,
        ),
      ),
    );
  }

  async function notifyTaskEdited(
    taskId: string,
    actorId: string,
    changes: UpdateTaskInput,
  ) {
    const [taskRes, assigneesRes, actorRes] = await Promise.all([
      supabase.from('tasks' as any).select('title, workspace_id').eq('id', taskId).single(),
      supabase.from('task_assignees' as any).select('user_id').eq('task_id', taskId),
      supabase.from('profiles' as any).select('display_name, username').eq('id', actorId).single(),
    ]);

    const taskRow = taskRes.data as any;
    if (taskRes.error || !taskRow) return;

    const assigneeIds = ((assigneesRes.data || []) as any[])
      .map((a: any) => a.user_id)
      .filter((id: string) => id !== actorId);

    if (assigneeIds.length === 0) return;

    const actorRow = actorRes.data as any;
    const actorName = actorRow?.display_name || actorRow?.username || 'Someone';
    const title = taskRow.title;
    const link = `/tasks/${taskId}`;

    const changedParts: string[] = [];
    if (changes.title) changedParts.push(`the title to "${changes.title}"`);
    if (changes.description) changedParts.push('the description');
    if (changedParts.length === 0) return;
    const detail = changedParts.join(' and ');

    await Promise.allSettled(
      assigneeIds.map((recipientId: string) =>
        createTypedNotification(
          recipientId,
          'system',
          `Task updated: ${title}`,
          `${actorName} updated the task "${title}" and changed ${detail}`,
          link,
          'tasks',
          'task',
          taskId,
          actorId,
          taskRow.workspace_id,
        ),
      ),
    );
  }

  return useMemo(
    () => ({
      tasks,
      isLoading,
      error,
      createTask,
      updateTask,
      updateTaskStatus,
      deleteTask,
      duplicateTask,
      archiveTask,
      restoreTask,
      convertMessageToTask,
      refetch: fetchTasks,
      getTaskComments,
      addTaskComment,
      updateTaskComment,
      deleteTaskComment,
      getTaskActivity,
      assignUser,
      unassignUser,
      getTaskAssignees,
      getLabels,
      createLabel,
      assignLabel,
      unassignLabel,
      getTaskLabels,
      setFilters,
    }),
    [
      tasks,
      isLoading,
      error,
      createTask,
      updateTask,
      updateTaskStatus,
      deleteTask,
      duplicateTask,
      archiveTask,
      restoreTask,
      convertMessageToTask,
      fetchTasks,
      getTaskComments,
      addTaskComment,
      updateTaskComment,
      deleteTaskComment,
      getTaskActivity,
      assignUser,
      unassignUser,
      getTaskAssignees,
      getLabels,
      createLabel,
      assignLabel,
      unassignLabel,
      getTaskLabels,
      setFilters,
    ],
  );
}
