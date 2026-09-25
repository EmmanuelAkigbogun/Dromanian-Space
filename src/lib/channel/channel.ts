import { supabase } from '@/lib/supabase';
import { createTypedNotification } from '@/features/notifications/service';
import type { Channel, ChannelMember, ChannelRole, Profile } from '@/types';

const ATTACHMENTS_BUCKET = 'message-attachments';

export interface WorkspaceMemberWithProfile {
  user_id: string;
  role: string;
  profile: Profile | null;
}

export async function getWorkspaceMembersWithProfiles(
  workspaceId: string,
): Promise<WorkspaceMemberWithProfile[]> {
  const { data: members, error: membersError } = await supabase
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId);

  if (membersError || !members || members.length === 0) return [];

  const userIds = members.map((m) => m.user_id);

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, email, display_name, username, avatar_url, status')
    .in('id', userIds);

  const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));

  return members.map((row) => ({
    user_id: row.user_id,
    role: row.role,
    profile: (profileMap.get(row.user_id) as Profile | null) ?? null,
  }));
}

export async function getChannelMemberIds(channelId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('channel_members')
    .select('user_id')
    .eq('channel_id', channelId);

  if (error || !data) return [];
  return data.map((row) => row.user_id);
}

export async function getWorkspaceChannels(workspaceId: string): Promise<Channel[]> {
  const { data, error } = await supabase
    .from('channels')
    .select('*')
    .eq('workspace_id', workspaceId)
    .is('archived_at', null)
    .order('created_at', { ascending: true });

  // A failed query must not be indistinguishable from "no channels" — the
  // caller needs to show a real error state instead of an empty page.
  if (error) {
    console.error('Failed to load workspace channels:', error);
    throw new Error('Failed to load channels');
  }

  return (data ?? []) as Channel[];
}

export async function getArchivedChannels(workspaceId: string): Promise<Channel[]> {
  const { data, error } = await supabase
    .from('channels')
    .select('*')
    .eq('workspace_id', workspaceId)
    .not('archived_at', 'is', null)
    .order('archived_at', { ascending: false });

  if (error) {
    console.error('Failed to load archived channels:', error);
    throw new Error('Failed to load archived channels');
  }

  return (data ?? []) as Channel[];
}

export async function getChannelById(channelId: string): Promise<Channel | null> {
  const { data, error } = await supabase
    .from('channels')
    .select('*')
    .eq('id', channelId)
    .single();

  if (error || !data) return null;
  return data as Channel;
}

export async function getChannelBySlug(
  workspaceId: string,
  slug: string,
): Promise<Channel | null> {
  const { data, error } = await supabase
    .from('channels')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('slug', slug)
    .maybeSingle();

  // Only a genuine miss returns null — a failed lookup must throw so the
  // caller can offer a retry instead of showing "channel not found".
  if (error) {
    console.error('Failed to load channel by slug:', error);
    throw new Error('Failed to open channel');
  }

  if (data) return data as Channel;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);
  if (!isUuid) return null;

  const { data: byId, error: byIdError } = await supabase
    .from('channels')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', slug)
    .maybeSingle();

  if (byIdError) {
    console.error('Failed to load channel by id:', byIdError);
    throw new Error('Failed to open channel');
  }

  return (byId as Channel) ?? null;
}

export async function createChannel(
  workspaceId: string,
  name: string,
  slug: string,
  createdBy: string,
  options?: {
    description?: string;
    topic?: string;
    type?: Channel['type'];
    isPrivate?: boolean;
  },
): Promise<Channel | null> {
  const { data, error } = await supabase
    .from('channels')
    .insert({
      workspace_id: workspaceId,
      name,
      slug,
      description: options?.description ?? null,
      topic: options?.topic ?? null,
      type: options?.type ?? 'text',
      is_private: options?.isPrivate ?? false,
      created_by: createdBy,
    })
    .select()
    .single();

  if (error || !data) return null;

  const { error: memberError } = await supabase.from('channel_members').insert({
    channel_id: data.id,
    user_id: createdBy,
    role: 'owner',
  });

  if (memberError) {
    console.error('Failed to add creator as channel member:', memberError);
  }

  notifyWorkspaceMembersChannelCreated(workspaceId, createdBy, data.id, name).catch(() => {});

  return data as Channel;
}

async function notifyWorkspaceMembersChannelCreated(
  workspaceId: string,
  creatorId: string,
  channelId: string,
  channelName: string,
): Promise<void> {
  const [members, creatorProfile] = await Promise.all([
    supabase.from('workspace_members').select('user_id').eq('workspace_id', workspaceId),
    supabase.from('profiles').select('display_name, username').eq('id', creatorId).single(),
  ]);

  if (members.error || !members.data) return;

  const recipientIds = members.data
    .map((m) => m.user_id)
    .filter((id) => id !== creatorId);

  if (recipientIds.length === 0) return;

  const creatorName = creatorProfile.data?.display_name || creatorProfile.data?.username || 'Someone';
  const link = `/channels/${channelId}`;

  await Promise.allSettled(
    recipientIds.map((recipientId) =>
      createTypedNotification(
        recipientId,
        'system',
        `New channel: #${channelName}`,
        `${creatorName} created the channel #${channelName}`,
        link,
        'channels',
        'channel',
        channelId,
        creatorId,
        workspaceId,
      ),
    ),
  );
}

export async function updateChannel(
  channelId: string,
  updates: Partial<Pick<Channel, 'name' | 'description' | 'topic' | 'type' | 'is_private'>>,
): Promise<Channel | null> {
  const { data, error } = await supabase
    .from('channels')
    .update(updates)
    .eq('id', channelId)
    .select()
    .single();

  if (error || !data) return null;
  return data as Channel;
}

export async function archiveChannel(channelId: string): Promise<Channel | null> {
  const { data, error } = await supabase
    .from('channels')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', channelId)
    .select()
    .single();

  if (error || !data) return null;
  return data as Channel;
}

export async function restoreChannel(channelId: string): Promise<Channel | null> {
  const { data, error } = await supabase
    .from('channels')
    .update({ archived_at: null })
    .eq('id', channelId)
    .select()
    .single();

  if (error || !data) return null;
  return data as Channel;
}

export async function deleteChannel(channelId: string): Promise<boolean> {
  const { data: files } = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .list(channelId);

  if (files && files.length > 0) {
    const paths = files.map((f) => `${channelId}/${f.name}`);
    await supabase.storage.from(ATTACHMENTS_BUCKET).remove(paths);
  }

  const { error } = await supabase
    .from('channels')
    .delete()
    .eq('id', channelId);

  return !error;
}

export async function getChannelMembers(channelId: string): Promise<ChannelMember[]> {
  const { data, error } = await supabase
    .from('channel_members')
    .select('*')
    .eq('channel_id', channelId);

  if (error || !data) return [];
  return data as ChannelMember[];
}

export async function addChannelMember(
  channelId: string,
  userId: string,
  role: ChannelRole = 'member',
): Promise<ChannelMember | null> {
  const { data, error } = await supabase
    .from('channel_members')
    .upsert({
      channel_id: channelId,
      user_id: userId,
      role,
    }, { onConflict: 'channel_id,user_id' })
    .select()
    .single();

  if (error || !data) return null;

  const [channel, existingMembers, joinerProfile] = await Promise.all([
    supabase.from('channels').select('name, workspace_id').eq('id', channelId).single(),
    supabase.from('channel_members').select('user_id').eq('channel_id', channelId),
    supabase.from('profiles').select('display_name, username').eq('id', userId).single(),
  ]);

  if (channel.data) {
    const channelName = channel.data.name;
    const workspaceId = channel.data.workspace_id;
    const link = `/channels/${channelId}`;
    const joinerName = joinerProfile.data?.display_name || joinerProfile.data?.username || 'Someone';

    const otherMemberIds = (existingMembers.data || [])
      .map((m) => m.user_id)
      .filter((id) => id !== userId);

    const notificationPromises: Promise<boolean>[] = [];

    notificationPromises.push(
      createTypedNotification(
        userId,
        'system',
        `Added to #${channelName}`,
        `You have been added to the channel #${channelName}`,
        link,
        'channels',
        'channel',
        channelId,
        null,
        workspaceId,
      ),
    );

    for (const memberId of otherMemberIds) {
      notificationPromises.push(
        createTypedNotification(
          memberId,
          'system',
          `New member in #${channelName}`,
          `${joinerName} joined the channel #${channelName}`,
          link,
          'channels',
          'channel',
          channelId,
          userId,
          workspaceId,
        ),
      );
    }

    await Promise.allSettled(notificationPromises);
  }

  return data as ChannelMember;
}

export async function removeChannelMember(
  channelId: string,
  userId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('channel_members')
    .delete()
    .eq('channel_id', channelId)
    .eq('user_id', userId);

  return !error;
}

export async function getUserChannelRole(
  channelId: string,
  userId: string,
): Promise<ChannelRole | null> {
  const { data, error } = await supabase
    .from('channel_members')
    .select('role')
    .eq('channel_id', channelId)
    .eq('user_id', userId)
    .single();

  if (error || !data) return null;
  return data.role as ChannelRole;
}

export async function isChannelMember(
  channelId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('channel_members')
    .select('id')
    .eq('channel_id', channelId)
    .eq('user_id', userId)
    .single();

  return !error && !!data;
}

export async function joinChannel(
  channelId: string,
  userId: string,
): Promise<ChannelMember | null> {
  return addChannelMember(channelId, userId, 'member');
}

export async function leaveChannel(
  channelId: string,
  userId: string,
): Promise<boolean> {
  return removeChannelMember(channelId, userId);
}

export async function inviteToChannel(
  channelId: string,
  userId: string,
  invitedBy: string,
): Promise<ChannelMember | null> {
  const role = await getUserChannelRole(channelId, invitedBy);
  if (!role || (role !== 'owner' && role !== 'admin')) return null;
  return addChannelMember(channelId, userId, 'member');
}

export async function getChannelMemberCounts(
  channelIds: string[],
): Promise<Record<string, number>> {
  if (channelIds.length === 0) return {};

  const { data, error } = await supabase
    .from('channel_members')
    .select('channel_id')
    .in('channel_id', channelIds);

  if (error || !data) return {};

  const counts: Record<string, number> = {};
  for (const row of data) {
    counts[row.channel_id] = (counts[row.channel_id] ?? 0) + 1;
  }
  return counts;
}
