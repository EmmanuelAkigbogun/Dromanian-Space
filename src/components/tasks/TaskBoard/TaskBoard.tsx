import { useState, useEffect } from 'react';
import { TaskCard } from '@/components/tasks/TaskCard';
import { supabase } from '@/lib/supabase';
import type { Task, TaskStatus } from '@/types/task';
import styles from './TaskBoard.module.css';

interface TaskBoardProps {
  tasks: Task[];
  onTaskClick?: (task: Task) => void;
  onStatusChange?: (taskId: string, status: TaskStatus) => void;
  onEdit?: (task: Task) => void;
  onRestore?: (task: Task) => void;
  onDuplicate?: (task: Task) => void;
  customStatusesVersion?: number;
  statusOrder?: { id: string; name: string }[] | null;
}

export function TaskBoard({ tasks, onTaskClick, onStatusChange, onEdit, onRestore, onDuplicate, customStatusesVersion = 0, statusOrder = null }: TaskBoardProps) {
  const [taskCustomStatuses, setTaskCustomStatuses] = useState<Record<string, { id: string; name: string }[]>>({});
  const [hiddenStatuses, setHiddenStatuses] = useState<Record<string, string[]>>({});

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
  if (tasks.length === 0) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
            <rect x="9" y="3" width="6" height="4" rx="1" />
          </svg>
        </div>
        <p className={styles.emptyTitle}>No tasks yet</p>
        <p className={styles.emptyText}>Create a task to get started</p>
      </div>
    );
  }

  return (
    <div className={styles.grid}>
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          onClick={onTaskClick}
          onStatusChange={onStatusChange}
          onEdit={onEdit}
          onRestore={onRestore}
          onDuplicate={onDuplicate}
          customStatuses={taskCustomStatuses[task.id] ?? []}
          statusOrder={statusOrder}
          hiddenStatuses={hiddenStatuses[task.id] ?? []}
        />
      ))}
    </div>
  );
}
