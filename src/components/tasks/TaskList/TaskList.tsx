import { useCallback, useState, useEffect } from 'react';
import { TaskCard } from '@/components/tasks/TaskCard';
import { useTasks } from '@/hooks/useTasks';
import { supabase } from '@/lib/supabase';
import type { Task, TaskStatus } from '@/types/task';
import styles from './TaskList.module.css';

interface TaskListProps {
  tasks: Task[];
  onTaskClick?: (task: Task) => void;
  onRestore?: (task: Task) => void;
  customStatusesVersion?: number;
  statusOrder?: { id: string; name: string }[] | null;
}

export function TaskList({ tasks, onTaskClick, onRestore, customStatusesVersion = 0, statusOrder = null }: TaskListProps) {
  const { updateTaskStatus, duplicateTask } = useTasks();
  const [assigneeNames, setAssigneeNames] = useState<Record<string, { name: string; avatar_url: string | null; email: string | null }>>({});
  const [taskLabels, setTaskLabels] = useState<Record<string, { id: string; name: string; color: string }[]>>({});
  const [taskCustomStatuses, setTaskCustomStatuses] = useState<Record<string, { id: string; name: string }[]>>({});
  const [hiddenStatuses, setHiddenStatuses] = useState<Record<string, string[]>>({});

  useEffect(() => {
    const loadData = async () => {
      const allUserIds = new Set<string>();
      for (const task of tasks) {
        const { data } = await supabase
          .from('task_assignees' as any)
          .select('user_id')
          .eq('task_id', task.id);
        if (data) {
          for (const row of data as unknown as { user_id: string }[]) {
            allUserIds.add(row.user_id);
          }
        }
      }

      if (allUserIds.size > 0) {
        const { data: profiles } = await supabase
          .from('profiles' as any)
          .select('id, display_name, username, email, avatar_url')
          .in('id', Array.from(allUserIds));

        if (profiles) {
          const map: Record<string, { name: string; avatar_url: string | null; email: string | null }> = {};
          for (const p of profiles as unknown as { id: string; display_name: string | null; username: string | null; email: string; avatar_url: string | null }[]) {
            map[p.id] = {
              name: p.display_name ?? p.username ?? p.email,
              avatar_url: p.avatar_url,
              email: p.email,
            };
          }
          setAssigneeNames(map);
        }
      }

      if (tasks.length > 0) {
        const taskIds = tasks.map((t) => t.id);
        const { data: assignments } = await supabase
          .from('task_label_assignments' as any)
          .select('task_id, label_id')
          .in('task_id', taskIds);

        if (assignments && assignments.length > 0) {
          const labelIds = [...new Set((assignments as unknown as { label_id: string }[]).map((a) => a.label_id))];
          const { data: labels } = await supabase
            .from('task_labels' as any)
            .select('id, name, color')
            .in('id', labelIds);

          if (labels) {
            const labelMap: Record<string, { id: string; name: string; color: string }> = {};
            for (const l of labels as unknown as { id: string; name: string; color: string }[]) {
              labelMap[l.id] = l;
            }
            const grouped: Record<string, { id: string; name: string; color: string }[]> = {};
            for (const a of assignments as unknown as { task_id: string; label_id: string }[]) {
              const label = labelMap[a.label_id];
              if (label) {
                if (!grouped[a.task_id]) grouped[a.task_id] = [];
                grouped[a.task_id].push(label);
              }
            }
            setTaskLabels(grouped);
          }
        }

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
      }
    };

    loadData();
  }, [tasks, customStatusesVersion]);

  const handleStatusChange = useCallback(
    (taskId: string, status: TaskStatus) => {
      updateTaskStatus(taskId, status);
    },
    [updateTaskStatus],
  );

  return (
    <div className={styles.taskList}>
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          onClick={onTaskClick}
          onStatusChange={handleStatusChange}
          onRestore={onRestore}
          onDuplicate={duplicateTask}
          assigneeNames={assigneeNames}
          labels={taskLabels[task.id] ?? []}
          customStatuses={taskCustomStatuses[task.id] ?? []}
          statusOrder={statusOrder}
          hiddenStatuses={hiddenStatuses[task.id] ?? []}
        />
      ))}
    </div>
  );
}
