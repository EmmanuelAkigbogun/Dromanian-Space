import { useState, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { TaskCard } from '@/components/tasks/TaskCard';
import { platform } from '@/lib/platform';
import type { Task, TaskStatus } from '@/types/task';
import styles from './TaskBoard.module.css';

/** Vertical space between cards, in px (the grid's rows are 1px tall). */
const CARD_GAP = 12;

/**
 * Masonry: each card spans as many 1px rows as it is tall, so cards keep
 * their order but fill the highest free gap. When a card grows (hover) or
 * shrinks, the others glide from where they were to their new place.
 */
function useMasonry(gridRef: RefObject<HTMLDivElement | null>, itemCount: number) {
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const items = () => [...grid.children] as HTMLElement[];

    const layout = (animate: boolean) => {
      const els = items();
      const before = animate && !reduceMotion ? new Map(els.map((el) => [el, el.getBoundingClientRect()])) : null;
      for (const el of els) {
        el.getAnimations().forEach((a) => a.cancel());
        el.style.gridRowEnd = `span ${Math.ceil(el.getBoundingClientRect().height + CARD_GAP)}`;
      }
      if (!before) return;
      for (const el of els) {
        const from = before.get(el)!;
        const to = el.getBoundingClientRect();
        const dx = from.left - to.left;
        const dy = from.top - to.top;
        if (Math.abs(dx) + Math.abs(dy) < 1) continue;
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
          duration: 260,
          easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        });
      }
    };

    layout(false);
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => layout(true));
    });
    items().forEach((el) => observer.observe(el));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [gridRef, itemCount]);
}

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
  const gridRef = useRef<HTMLDivElement>(null);
  useMasonry(gridRef, tasks.length);

  useEffect(() => {
    if (tasks.length === 0) return;
    const loadCustomStatuses = async () => {
      const taskIds = tasks.map((t) => t.id);
      const { data: customStatuses } = await platform
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
    <div ref={gridRef} className={styles.grid}>
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
