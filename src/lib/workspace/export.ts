import { supabase } from '@/lib/supabase';
import type { Workspace } from '@/types';

export interface WorkspaceExport {
  exported_at: string;
  workspace: Workspace | null;
  members: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
  channels: Record<string, unknown>[];
  channel_members: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  files: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  task_comments: Record<string, unknown>[];
  projects: Record<string, unknown>[];
  project_milestones: Record<string, unknown>[];
  invitations: Record<string, unknown>[];
}

export interface TasksExport {
  exported_at: string;
  workspace_id: string;
  scope: 'all' | 'project';
  project_id: string | null;
  tasks: Record<string, unknown>[];
  task_comments: Record<string, unknown>[];
  task_assignees: Record<string, unknown>[];
}

export interface ProjectsExport {
  exported_at: string;
  workspace_id: string;
  projects: Record<string, unknown>[];
  project_members: Record<string, unknown>[];
  project_milestones: Record<string, unknown>[];
}

export interface EventsExport {
  exported_at: string;
  workspace_id: string;
  events: Record<string, unknown>[];
  event_participants: Record<string, unknown>[];
}

// PostgREST rejects `in.(value)` when there is exactly one value (400 Bad
// Request), so fall back to `eq` for a single id and skip the query entirely
// when there are none.
function filterByIds<T>(query: T, column: string, ids: string[]): T | null {
  const builder = query as unknown as {
    eq: (c: string, v: string) => T;
    in: (c: string, a: string[]) => T;
  };
  if (ids.length === 1) return builder.eq(column, ids[0]);
  if (ids.length > 1) return builder.in(column, ids);
  return null;
}

export async function collectWorkspaceExport(workspaceId: string): Promise<WorkspaceExport> {
  const [workspaceResult, membersResult] = await Promise.all([
    supabase.from('workspaces').select('*').eq('id', workspaceId).single(),
    supabase.from('workspace_members').select('*').eq('workspace_id', workspaceId),
  ]);

  const memberIds = ((membersResult.data ?? []) as Array<{ user_id: string | null }>)
    .map((m) => m.user_id)
    .filter((id): id is string => !!id);

  const channelsResult = await supabase.from('channels').select('*').eq('workspace_id', workspaceId);
  const channelIds = ((channelsResult.data ?? []) as Array<{ id: string }>).map((c) => c.id);

  const tasksResult = await supabase
    .from('tasks')
    .select('id, title, description, status, priority, due_date, start_date, created_by, project_id, channel_id, milestone_id, archived_at, deleted_at, created_at, updated_at')
    .eq('workspace_id', workspaceId);
  const taskIds = ((tasksResult.data ?? []) as Array<{ id: string }>).map((t) => t.id);

  const projectsResult = await supabase
    .from('projects')
    .select('id, name, description, icon, color, status, visibility, due_date, owner_id, archived_at, created_at, updated_at')
    .eq('workspace_id', workspaceId);
  const projectIds = ((projectsResult.data ?? []) as Array<{ id: string }>).map((p) => p.id);

  const [
    profilesResult,
    channelMembersResult,
    messagesResult,
    filesResult,
    taskCommentsResult,
    milestonesResult,
    invitationsResult,
  ] = await Promise.all([
    filterByIds(supabase.from('profiles').select('*'), 'id', memberIds) ?? Promise.resolve({ data: [] }),
    filterByIds(supabase.from('channel_members').select('*'), 'channel_id', channelIds) ??
      Promise.resolve({ data: [] }),
    filterByIds(
      supabase
        .from('messages')
        .select('id, channel_id, user_id, content, parent_id, edited_at, deleted_at, created_at'),
      'channel_id',
      channelIds,
    ) ?? Promise.resolve({ data: [] }),
    supabase
      .from('file_attachments')
      .select('id, message_id, user_id, file_name, file_size, file_type, file_url, created_at'),
    filterByIds(
      supabase
        .from('task_comments')
        .select('id, task_id, user_id, content, parent_id, deleted_at, created_at'),
      'task_id',
      taskIds,
    ) ?? Promise.resolve({ data: [] }),
    filterByIds(
      supabase.from('project_milestones').select('id, project_id, title, description, due_date, status, created_at'),
      'project_id',
      projectIds,
    ) ?? Promise.resolve({ data: [] }),
    supabase
      .from('invitations')
      .select('id, workspace_id, invited_by, email, user_id, role, status, expires_at, created_at, updated_at')
      .eq('workspace_id', workspaceId),
  ]);

  return {
    exported_at: new Date().toISOString(),
    workspace: (workspaceResult.data as Workspace) ?? null,
    members: (membersResult.data as Record<string, unknown>[]) ?? [],
    profiles: (profilesResult.data as Record<string, unknown>[]) ?? [],
    channels: (channelsResult.data as Record<string, unknown>[]) ?? [],
    channel_members: (channelMembersResult.data as Record<string, unknown>[]) ?? [],
    messages: (messagesResult.data as Record<string, unknown>[]) ?? [],
    files: (filesResult.data as Record<string, unknown>[]) ?? [],
    tasks: (tasksResult.data as Record<string, unknown>[]) ?? [],
    task_comments: (taskCommentsResult.data as Record<string, unknown>[]) ?? [],
    projects: (projectsResult.data as Record<string, unknown>[]) ?? [],
    project_milestones: (milestonesResult.data as Record<string, unknown>[]) ?? [],
    invitations: (invitationsResult.data as Record<string, unknown>[]) ?? [],
  };
}

export async function collectTasksExport(
  workspaceId: string,
  projectId: string | null = null,
): Promise<TasksExport> {
  let tasksQuery = supabase
    .from('tasks')
    .select('id, title, description, status, priority, due_date, start_date, created_by, project_id, channel_id, milestone_id, archived_at, deleted_at, created_at, updated_at')
    .eq('workspace_id', workspaceId);
  if (projectId) {
    tasksQuery = tasksQuery.eq('project_id', projectId);
  }
  const { data: tasks } = await tasksQuery;

  const taskIds = (tasks ?? []).map((t) => t.id);

  const [taskCommentsResult, taskAssigneesResult] = await Promise.all([
    filterByIds(
      supabase
        .from('task_comments')
        .select('id, task_id, user_id, content, parent_id, deleted_at, created_at'),
      'task_id',
      taskIds,
    ) ?? Promise.resolve({ data: [] }),
    filterByIds(
      supabase.from('task_assignees').select('id, task_id, user_id, assigned_at'),
      'task_id',
      taskIds,
    ) ?? Promise.resolve({ data: [] }),
  ]);

  return {
    exported_at: new Date().toISOString(),
    workspace_id: workspaceId,
    scope: projectId ? 'project' : 'all',
    project_id: projectId,
    tasks: (tasks ?? []) as Record<string, unknown>[],
    task_comments: (taskCommentsResult.data ?? []) as Record<string, unknown>[],
    task_assignees: (taskAssigneesResult.data ?? []) as unknown as Record<string, unknown>[],
  };
}

export async function collectProjectsExport(workspaceId: string): Promise<ProjectsExport> {
  const [projectsResult, projectMembersResult, milestonesResult] = await Promise.all([
    supabase
      .from('projects')
      .select('id, name, description, icon, color, status, visibility, due_date, owner_id, archived_at, created_at, updated_at')
      .eq('workspace_id', workspaceId),
    supabase
      .from('project_members')
      .select('id, project_id, user_id, role, created_at')
      .in(
        'project_id',
        (
          await supabase.from('projects').select('id').eq('workspace_id', workspaceId)
        ).data?.map((p) => p.id) ?? [],
      ),
    supabase
      .from('project_milestones')
      .select('id, project_id, title, description, due_date, status, created_at')
      .in(
        'project_id',
        (
          await supabase.from('projects').select('id').eq('workspace_id', workspaceId)
        ).data?.map((p) => p.id) ?? [],
      ),
  ]);

  return {
    exported_at: new Date().toISOString(),
    workspace_id: workspaceId,
    projects: (projectsResult.data ?? []) as Record<string, unknown>[],
    project_members: (projectMembersResult.data ?? []) as Record<string, unknown>[],
    project_milestones: (milestonesResult.data ?? []) as Record<string, unknown>[],
  };
}

export async function collectEventsExport(workspaceId: string): Promise<EventsExport> {
  const [eventsResult, participantsResult] = await Promise.all([
    (supabase.from('calendar_events') as any)
      .select('id, workspace_id, user_id, title, description, start_at, end_at, all_day, location, color, project_id, task_id, created_at, updated_at, deleted_at')
      .eq('workspace_id', workspaceId),
    (supabase.from('event_participants') as any)
      .select('id, event_id, user_id, status, created_at')
      .in(
        'event_id',
        (
          await (supabase.from('calendar_events') as any).select('id').eq('workspace_id', workspaceId)
        ).data?.map((e: any) => e.id) ?? [],
      ),
  ]);

  return {
    exported_at: new Date().toISOString(),
    workspace_id: workspaceId,
    events: (eventsResult.data ?? []) as Record<string, unknown>[],
    event_participants: (participantsResult.data ?? []) as Record<string, unknown>[],
  };
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows || rows.length === 0) return '';
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escapeCell = (value: unknown): string => {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  }
  return lines.join('\r\n');
}

export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
  const blob = new Blob([`\ufeff${toCsv(rows)}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Downloads a JSON export object (or array) as one CSV file per top-level
// array field, so each collection ("messages", "tasks", ...) lands in its own
// .csv file. Passed a bare array, it writes a single .csv.
export function downloadCsvExport(filenameBase: string, data: unknown): void {
  const collections: Array<{ name: string; rows: Record<string, unknown>[] }> = [];

  if (Array.isArray(data)) {
    collections.push({ name: filenameBase, rows: data as Record<string, unknown>[] });
  } else if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        collections.push({ name: `${filenameBase}-${key}`, rows: value as Record<string, unknown>[] });
      }
    }
  }

  if (collections.length === 0) {
    downloadCsv(`${filenameBase}.csv`, []);
    return;
  }
  collections.forEach((c) => downloadCsv(`${c.name}.csv`, c.rows));
}

export function exportFileName(
  workspace: Workspace,
  label: string,
  date: string = new Date().toISOString().slice(0, 10),
  extension: 'json' | 'csv' = 'json',
): string {
  const base = (workspace.slug || workspace.name).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `${base}-${label}-${date}.${extension}`;
}

export async function logDataExport(
  workspaceId: string,
  scope = 'workspace',
  entityId: string | null = null,
): Promise<void> {
  await supabase.rpc('write_audit_log' as any, {
    p_workspace_id: workspaceId,
    p_action: 'data_exported',
    p_entity_type: scope,
    p_entity_id: entityId,
    p_metadata: { scope },
  });
}
