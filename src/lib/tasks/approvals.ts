// Task requests: tasks an agent prepared (from a channel, a pasted list or an
// AI session) that wait for a project manager. Approval creates the task.
import { platform } from '@/lib/platform';
import type { TaskPriority } from '@/types/task';

export interface TaskRequest {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  priority: Exclude<TaskPriority, 'none'>;
  due_date: string | null;
  project_id: string | null;
  assignee_ids: string[];
  source_channel_id: string | null;
  source_label: string | null;
  submitted_by: string;
  agent_id: string | null;
  agent_run_id: string | null;
  status: 'pending' | 'approved' | 'rejected';
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  task_id: string | null;
  created_at: string;
}

export interface TaskRequestChanges {
  title?: string;
  description?: string;
  priority?: string;
  due_date?: string | null;
  project_id?: string | null;
  assignee_ids?: string[];
}

export async function listTaskRequests(workspaceId: string): Promise<TaskRequest[]> {
  const pending = platform
    .from<TaskRequest[]>('task_requests')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  const decided = platform
    .from<TaskRequest[]>('task_requests')
    .select('*')
    .eq('workspace_id', workspaceId)
    .neq('status', 'pending')
    .order('decided_at', { ascending: false })
    .limit(20);
  const [a, b] = await Promise.all([pending, decided]);
  if (a.error) throw new Error(a.error.message);
  return [...(a.data ?? []), ...(b.data ?? [])];
}

export async function decideTaskRequest(
  requestId: string,
  approve: boolean,
  changes: TaskRequestChanges = {},
  note?: string,
): Promise<{ status: string; task_id?: string }> {
  const { data, error } = await platform.rpc('decide_task_request', {
    p_request_id: requestId,
    p_approve: approve,
    p_changes: changes,
    p_note: note ?? null,
  });
  if (error) throw new Error(error.message);
  return data as { status: string; task_id?: string };
}

export async function isTaskApprover(workspaceId: string, userId: string): Promise<boolean> {
  const { data, error } = await platform.rpc('is_task_approver', { p_workspace_id: workspaceId, p_user_id: userId });
  return !error && data === true;
}

export async function listProjectManagers(workspaceId: string): Promise<string[]> {
  const { data } = await platform.from<Array<{ user_id: string }>>('workspace_project_managers').select('user_id').eq('workspace_id', workspaceId);
  return (data ?? []).map((r) => r.user_id);
}

export async function setProjectManager(workspaceId: string, userId: string, enabled: boolean): Promise<void> {
  const { error } = await platform.rpc('set_project_manager', { p_workspace_id: workspaceId, p_user_id: userId, p_enabled: enabled });
  if (error) throw new Error(error.message);
}

/** Calls back whenever a request in this workspace is added or decided. */
export function subscribeToTaskRequests(workspaceId: string, onChange: () => void): () => void {
  const channel = platform
    .channel(`task-requests:${workspaceId}:${Math.random().toString(36).slice(2, 9)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'task_requests', filter: `workspace_id=eq.${workspaceId}` }, onChange)
    .subscribe();
  return () => {
    platform.removeChannel(channel);
  };
}
