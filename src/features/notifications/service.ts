import { supabase } from '@/lib/supabase';
import type { Notification, NotificationType } from '@/types';

export type NotificationCategory = 'messaging' | 'workspace' | 'channels' | 'projects' | 'tasks' | 'calendar';
export type EntityType = 'message' | 'channel' | 'workspace' | 'user' | 'file' | 'invitation' | 'project' | 'task' | 'event';

export interface TypedNotification extends Notification {
  category: NotificationCategory;
  entity_type: EntityType;
  entity_id: string | null;
  actor_id: string | null;
  workspace_id: string | null;
}

export async function getNotifications(userId: string): Promise<Notification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error || !data) return [];
  return data as Notification[];
}

export async function getUnreadCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('read', false);

  if (error) return 0;
  return count ?? 0;
}

export async function markAsRead(notificationId: string): Promise<boolean> {
  const { error } = await supabase
    .from('notifications')
    .update({ read: true })
    .eq('id', notificationId);

  return !error;
}

export async function markAllAsRead(userId: string): Promise<boolean> {
  const { error } = await supabase
    .from('notifications')
    .update({ read: true })
    .eq('user_id', userId)
    .eq('read', false);

  return !error;
}

export async function deleteNotification(notificationId: string): Promise<boolean> {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('id', notificationId);

  return !error;
}

export async function createInvitationNotification(
  invitedUserId: string,
  workspaceName: string,
  invitedByDisplayName: string,
  role: string,
  options?: { workspaceId?: string; actorId?: string },
): Promise<boolean> {
  const { error } = await supabase
    .from('notifications')
    .insert({
      user_id: invitedUserId,
      type: 'invitation',
      title: 'Workspace invitation',
      message: `${invitedByDisplayName} invited you to join ${workspaceName} as ${role}`,
      link: '/invitations',
      category: 'workspace',
      entity_type: 'invitation',
      actor_id: options?.actorId ?? null,
      workspace_id: options?.workspaceId ?? null,
    } as any);

  return !error;
}

export async function getNotificationsPaginated(
  userId: string,
  options?: { limit?: number; offset?: number },
): Promise<TypedNotification[]> {
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error || !data) return [];
  return data as TypedNotification[];
}

export async function createTypedNotification(
  userId: string,
  type: NotificationType,
  title: string,
  message: string,
  link: string | null,
  category: NotificationCategory,
  entityType: EntityType,
  entityId: string | null,
  actorId: string | null,
  workspaceId: string | null,
): Promise<boolean> {
  const { error } = await supabase.rpc('create_notification' as never, {
    p_user_id: userId,
    p_type: type,
    p_title: title,
    p_message: message,
    p_link: link,
    p_category: category,
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_actor_id: actorId,
    p_workspace_id: workspaceId,
  } as never);

  if (error) {
    const { error: fallbackError } = await supabase.from('notifications').insert({
      user_id: userId,
      type,
      title,
      message,
      link,
    });
    return !fallbackError;
  }
  return true;
}

export async function getNotificationUnreadCount(_userId: string): Promise<number> {
  const { data, error } = await supabase.rpc('get_notification_unread_count' as never);

  if (error) {
    return getUnreadCount(_userId);
  }
  return (data as number) ?? 0;
}

export async function markNotificationRead(notificationId: string): Promise<boolean> {
  const { error } = await supabase.rpc('mark_notification_read' as never, {
    p_notification_id: notificationId,
  } as never);

  if (error) {
    return markAsRead(notificationId);
  }
  return true;
}

export async function markAllNotificationsRead(userId: string): Promise<boolean> {
  const { error } = await supabase.rpc('mark_all_notifications_read' as never);

  if (error) {
    return markAllAsRead(userId);
  }
  return true;
}

export function subscribeToNotifications(
  userId: string,
  callback: (notification: TypedNotification) => void,
) {
  const instanceId = Math.random().toString(36).slice(2, 9);
  const channel = supabase
    .channel(`notifications-realtime:${instanceId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        callback(payload.new as TypedNotification);
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
