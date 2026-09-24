import { supabase } from '@/lib/supabase';

export interface TypographyPrefs {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
}

export interface WorkspaceSettings {
  workspace_id: string;
  default_channel_ids: string[];
  retention_days: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  typography: TypographyPrefs | null;
  colors: string | null;
}

function toIdArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    const trimmed = value.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      // fall through to Postgres array literal
    }
    const matches = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    if (matches) return matches;
  }
  return [];
}

export async function getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettings | null> {
  const { data, error } = await supabase.rpc('get_workspace_settings' as any, {
    p_workspace_id: workspaceId,
  });

  if (error || !data) return null;
  const result = data as { success?: boolean; error?: string } & Partial<WorkspaceSettings>;
  if (result.success === false) return null;
  return {
    workspace_id: result.workspace_id ?? workspaceId,
    default_channel_ids: toIdArray(result.default_channel_ids),
    retention_days:
      typeof result.retention_days === 'number' ? result.retention_days : Number(result.retention_days) || 0,
    quiet_hours_start: result.quiet_hours_start ?? null,
    quiet_hours_end: result.quiet_hours_end ?? null,
    typography: (result.typography as TypographyPrefs | null) ?? null,
    colors: typeof result.colors === 'string' ? result.colors : null,
  };
}

export function isWithinQuietHours(
  start: string | null,
  end: string | null,
  now = new Date(),
): boolean {
  if (!start || !end || start === end) return false;

  const toMinutes = (t: string): number => {
    const [h, m] = t.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);

  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export async function saveWorkspaceSettings(
  workspaceId: string,
  settings: {
    default_channel_ids?: string[];
    retention_days?: number;
    quiet_hours_start?: string | null;
    quiet_hours_end?: string | null;
    typography?: TypographyPrefs | null;
    colors?: string | null;
    clearTypography?: boolean;
    clearColors?: boolean;
  },
): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('upsert_workspace_settings' as any, {
    p_workspace_id: workspaceId,
    p_default_channel_ids: settings.default_channel_ids ?? null,
    p_retention_days: settings.retention_days ?? null,
    p_quiet_hours_start: settings.quiet_hours_start ?? null,
    p_quiet_hours_end: settings.quiet_hours_end ?? null,
    p_typography: settings.typography ?? null,
    p_colors: settings.colors ?? null,
    p_clear_typography: settings.clearTypography ?? false,
    p_clear_colors: settings.clearColors ?? false,
  });

  if (error) return { success: false, error: 'Failed to save settings.' };
  return (data as { success: boolean; error?: string }) ?? { success: false };
}

export interface AuditLogEntry {
  id: string;
  workspace_id: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
  actor_avatar: string | null;
}

const ACTION_LABELS: Record<string, string> = {
  member_joined: 'Member joined',
  member_left: 'Member left',
  channel_insert: 'Channel created',
  channel_update: 'Channel updated',
  channel_delete: 'Channel deleted',
  message_deleted: 'Message deleted',
  data_exported: 'Data export',
  invitation_created: 'Invitation sent',
  invitation_cancelled: 'Invitation cancelled',
};

export function describeAuditAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export async function getAuditLog(workspaceId: string, limit = 100): Promise<AuditLogEntry[]> {
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  const entries = data as unknown as Omit<AuditLogEntry, 'actor_name' | 'actor_avatar'>[];
  const actorIds = [...new Set(entries.map((e) => e.actor_id).filter((id): id is string => !!id))];

  const profileMap = new Map<string, { display_name: string | null; avatar_url: string | null }>();
  if (actorIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name, avatar_url')
      .in('id', actorIds);
    if (profiles) {
      for (const p of profiles) {
        profileMap.set(p.id, { display_name: p.display_name, avatar_url: p.avatar_url });
      }
    }
  }

  return entries.map((e) => {
    const actor = e.actor_id ? profileMap.get(e.actor_id) : undefined;
    return {
      ...e,
      actor_name: actor?.display_name ?? null,
      actor_avatar: actor?.avatar_url ?? null,
    };
  });
}
