import { TASK_STATUS_OPTIONS } from '@/types/task';

const DEFAULT_STATUS_ORDER = TASK_STATUS_OPTIONS.map((o) => o.value);

function findLastNonCancelledIndex(order: string[]): number {
  for (let i = order.length - 1; i >= 0; i--) {
    if (order[i] !== 'cancelled') return i;
  }
  return -1;
}

function getOrder(status: string, order?: string[] | null): string[] {
  if (order && Array.isArray(order)) return order;
  return DEFAULT_STATUS_ORDER;
}

function getStatusWeight(status: string, order: string[]): number {
  const lastIdx = findLastNonCancelledIndex(order);
  if (lastIdx === -1) return 0;
  if (status === 'cancelled') return 0;
  const idx = order.indexOf(status);
  if (idx === -1) return 0;
  return idx / lastIdx;
}

export function calculateTaskProgress(
  tasks: { status: string; status_order?: string[] | null }[],
): number {
  if (tasks.length === 0) return 0;

  let total = 0;
  for (const task of tasks) {
    total += getStatusWeight(task.status, getOrder(task.status, task.status_order)) * 100;
  }

  return Math.round(total / tasks.length);
}

export function calculateCompletedTaskCount(
  tasks: { status: string; status_order?: string[] | null }[],
): number {
  let count = 0;
  for (const task of tasks) {
    const order = getOrder(task.status, task.status_order);
    const lastIdx = findLastNonCancelledIndex(order);
    if (lastIdx === -1) continue;
    if (task.status === 'cancelled') continue;
    const idx = order.indexOf(task.status);
    if (idx === lastIdx) count++;
  }
  return count;
}
