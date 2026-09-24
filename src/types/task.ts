import type { UUID } from '@/types';

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'completed' | 'cancelled';
export type TaskPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: UUID;
  workspace_id: UUID;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  start_date: string | null;
  created_by: UUID;
  project_id: UUID | null;
  column_id: UUID | null;
  channel_id: UUID | null;
  message_id: UUID | null;
  milestone_id: UUID | null;
  sort_order: number;
  archived_at: string | null;
  deleted_at: string | null;
  status_order: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface TaskAssignee {
  id: UUID;
  task_id: UUID;
  user_id: UUID;
  created_at: string;
}

export interface TaskLabel {
  id: UUID;
  workspace_id: UUID;
  name: string;
  color: string;
  created_at: string;
}

export interface TaskLabelAssignment {
  id: UUID;
  task_id: UUID;
  label_id: UUID;
}

export interface TaskComment {
  id: UUID;
  task_id: UUID;
  user_id: UUID;
  content: string;
  parent_id: UUID | null;
  created_at: string;
  updated_at: string;
}

export interface TaskActivity {
  id: UUID;
  task_id: UUID;
  user_id: UUID;
  action: TaskAction;
  description: string | null;
  details: Record<string, unknown> | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

export type TaskAction = 'created' | 'status_changed' | 'assigned' | 'unassigned' | 'completed' | 'priority_changed' | 'edited' | 'commented' | 'label_added' | 'label_removed';

export const TASK_STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'review', label: 'Review' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export const TASK_PRIORITY_OPTIONS: { value: TaskPriority; label: string; color: string }[] = [
  { value: 'none', label: 'None', color: 'var(--color-text-muted)' },
  { value: 'low', label: 'Low', color: '#4A90D9' },
  { value: 'medium', label: 'Medium', color: '#D4A03C' },
  { value: 'high', label: 'High', color: '#E8784A' },
  { value: 'urgent', label: 'Urgent', color: '#C43E3E' },
];

export function getStatusColor(status: TaskStatus): string {
  switch (status) {
    case 'backlog': return 'var(--color-text-muted)';
    case 'todo': return 'var(--color-info)';
    case 'in_progress': return 'var(--color-warning)';
    case 'review': return '#8B5CF6';
    case 'completed': return 'var(--color-success)';
    case 'cancelled': return 'var(--color-error)';
    default: return 'var(--color-text-muted)';
  }
}

export function getStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

export function getPriorityColor(priority: TaskPriority): string {
  return TASK_PRIORITY_OPTIONS.find((o) => o.value === priority)?.color ?? 'var(--color-text-muted)';
}
