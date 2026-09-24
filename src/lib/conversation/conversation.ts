import { supabase } from '@/lib/supabase';
import type { Profile } from '@/types';

const db = supabase as any;

export interface DirectConversation {
  id: string;
  workspace_id: string;
  channel_id: string;
  type: 'dm' | 'group';
  name: string | null;
  avatar_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationParticipant {
  id: string;
  conversation_id: string;
  user_id: string;
  created_at: string;
}

export interface ConversationWithParticipants extends DirectConversation {
  participants: (ConversationParticipant & { profile: Profile | null })[];
  lastMessage?: { content: string; created_at: string; user_id: string } | null;
}

export async function getUserConversations(
  userId: string,
  workspaceId: string,
): Promise<ConversationWithParticipants[]> {
  const { data: participations, error } = await (supabase as any)
    .from('direct_conversation_participants')
    .select('conversation_id')
    .eq('user_id', userId);

  if (error || !participations || participations.length === 0) return [];

  const convIds = participations.map((p: any) => p.conversation_id);

  const { data: conversations } = await supabase
    .from('direct_conversations' as any)
    .select('*')
    .in('id', convIds)
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false });

  if (!conversations) return [];

  const convList = conversations as any[];
  const channelIds = convList.map((c: any) => c.channel_id);

  // Batch all participant lookups, all profiles, and all last-message lookups
  // into 3 total queries instead of 3 per conversation.
  const [{ data: parts }, { data: lastMessages }] = await Promise.all([
    supabase
      .from('direct_conversation_participants')
      .select('*')
      .in('conversation_id', convIds),
    channelIds.length > 0
      ? (supabase as any).rpc('get_last_messages_for_channels', { p_channel_ids: channelIds })
      : { data: [] as any[] },
  ]);

  const partsList = (parts ?? []) as any[];
  const allUserIds = Array.from(new Set(partsList.map((p: any) => p.user_id)));
  let profiles: Profile[] = [];
  if (allUserIds.length > 0) {
    const { data: profileData } = await supabase
      .from('profiles')
      .select('*')
      .in('id', allUserIds);
    profiles = (profileData as Profile[]) ?? [];
  }
  const profileMap = new Map(profiles.map((p) => [p.id, p]));

  const lastMsgByChannel = new Map<string, { content: string; created_at: string; user_id: string }>();
  for (const row of (lastMessages ?? []) as any[]) {
    lastMsgByChannel.set(row.channel_id, {
      content: row.content,
      created_at: row.created_at,
      user_id: row.user_id,
    });
  }

  const results: ConversationWithParticipants[] = [];

  for (const conv of convList) {
    const enrichedParticipants = partsList
      .filter((p: any) => p.conversation_id === conv.id)
      .map((p: any) => ({
        ...p,
        profile: profileMap.get(p.user_id) ?? null,
      }));

    results.push({
      ...(conv as DirectConversation),
      participants: enrichedParticipants,
      lastMessage: lastMsgByChannel.get(conv.channel_id) ?? null,
    });
  }

  return results;
}

export async function getOrCreateDmConversation(
  workspaceId: string,
  createdBy: string,
  otherUserId: string,
): Promise<DirectConversation | null> {
  const isSelfDm = otherUserId === createdBy;

  // Check if DM already exists
  const { data: existing } = await supabase
    .from('direct_conversation_participants')
    .select('conversation_id')
    .eq('user_id', createdBy);

  if (existing && existing.length > 0) {
    const convIds = (existing as any[]).map((p: any) => p.conversation_id);
    const { data: convs } = await supabase
      .from('direct_conversations' as any)
      .select('*')
      .in('id', convIds)
      .eq('workspace_id', workspaceId)
      .eq('type', 'dm');

    if (convs) {
      for (const conv of convs as any[]) {
        const { data: parts } = await supabase
          .from('direct_conversation_participants' as any)
          .select('user_id')
          .eq('conversation_id', conv.id);
        const userIds = ((parts as any[]) ?? []).map((p: any) => p.user_id);
        if (isSelfDm) {
          if (userIds.length === 1 && userIds[0] === createdBy) {
            return conv as DirectConversation;
          }
        } else if (userIds.includes(otherUserId) && userIds.includes(createdBy)) {
          return conv as DirectConversation;
        }
      }
    }
  }

  // Create backing channel
  const slug = 'dm-' + crypto.randomUUID().slice(0, 8);
  const { data: channel, error: chErr } = await supabase
    .from('channels')
    .insert({ workspace_id: workspaceId, name: 'Direct Message', slug, type: 'text', is_private: true, created_by: createdBy })
    .select()
    .single();

  if (chErr || !channel) return null;

  // Add users as channel members
  if (isSelfDm) {
    await supabase.from('channel_members').insert([
      { channel_id: channel.id, user_id: createdBy, role: 'owner' },
    ]);
  } else {
    await supabase.from('channel_members').insert([
      { channel_id: channel.id, user_id: createdBy, role: 'owner' },
      { channel_id: channel.id, user_id: otherUserId, role: 'member' },
    ]);
  }

  // Create conversation
  const { data: conv, error: convErr } = await supabase
    .from('direct_conversations' as any)
    .insert({ workspace_id: workspaceId, channel_id: channel.id, type: 'dm', created_by: createdBy })
    .select()
    .single();

  if (convErr || !conv) return null;

  // Add participants
  if (isSelfDm) {
    await supabase.from('direct_conversation_participants' as any).insert([
      { conversation_id: (conv as any).id, user_id: createdBy },
    ]);
  } else {
    await supabase.from('direct_conversation_participants' as any).insert([
      { conversation_id: (conv as any).id, user_id: createdBy },
      { conversation_id: (conv as any).id, user_id: otherUserId },
    ]);
  }

  return conv as unknown as DirectConversation;
}

export async function getOrCreateGroupConversation(
  workspaceId: string,
  createdBy: string,
  participantIds: string[],
  name: string,
): Promise<DirectConversation | null> {
  // Create backing channel
  const slug = 'group-' + crypto.randomUUID().slice(0, 8);
  const { data: channel, error: chErr } = await supabase
    .from('channels')
    .insert({ workspace_id: workspaceId, name, slug, type: 'text', is_private: true, created_by: createdBy })
    .select()
    .single();

  if (chErr || !channel) return null;

  // Add all members
  const members = [
    { channel_id: channel.id, user_id: createdBy, role: 'owner' },
    ...participantIds.map((id) => ({ channel_id: channel.id, user_id: id, role: 'member' as const })),
  ];
  await supabase.from('channel_members').insert(members);

  // Create conversation
  const { data: conv, error: convErr } = await supabase
    .from('direct_conversations' as any)
    .insert({ workspace_id: workspaceId, channel_id: channel.id, type: 'group', name, created_by: createdBy })
    .select()
    .single();

  if (convErr || !conv) return null;

  // Add participants
  const participants = [
    { conversation_id: (conv as any).id, user_id: createdBy },
    ...participantIds.map((id) => ({ conversation_id: (conv as any).id, user_id: id })),
  ];
  await supabase.from('direct_conversation_participants' as any).insert(participants);

  return conv as unknown as DirectConversation;
}

export async function getConversationById(
  conversationId: string,
): Promise<DirectConversation | null> {
  const { data, error } = await supabase
    .from('direct_conversations' as any)
    .select('*')
    .eq('id', conversationId)
    .single();

  if (error || !data) return null;
  return data as unknown as DirectConversation;
}

export async function getConversationParticipants(
  conversationId: string,
): Promise<(ConversationParticipant & { profile: Profile | null })[]> {
  const { data: parts, error } = await supabase
    .from('direct_conversation_participants' as any)
    .select('*')
    .eq('conversation_id', conversationId);

  if (error || !parts) return [];

  const userIds = (parts as any[]).map((p: any) => p.user_id);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('*')
    .in('id', userIds);

  const profileMap = new Map((profiles as Profile[] ?? []).map((p) => [p.id, p]));

  return (parts as any[]).map((p: any) => ({
    ...p,
    profile: profileMap.get(p.user_id) ?? null,
  }));
}

export async function isUserInConversation(
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const { count } = await supabase
    .from('direct_conversation_participants')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('user_id', userId);

  return (count ?? 0) > 0;
}

export async function getConversationByChannelId(
  channelId: string,
): Promise<DirectConversation | null> {
  const { data, error } = await supabase
    .from('direct_conversations' as any)
    .select('*')
    .eq('channel_id', channelId)
    .single();

  if (error || !data) return null;
  return data as unknown as DirectConversation;
}

export async function getDmChannelDisplayNames(
  userId: string,
  workspaceId: string,
): Promise<Record<string, string>> {
  const { data: conversations } = await (supabase as any)
    .from('direct_conversations')
    .select('id, channel_id')
    .eq('workspace_id', workspaceId)
    .eq('type', 'dm');

  if (!conversations || conversations.length === 0) return {};

  const channelIds = conversations.map((c: any) => c.channel_id);
  const conversationIds = conversations.map((c: any) => c.id);

  const { data: parts } = await (supabase as any)
    .from('direct_conversation_participants')
    .select('conversation_id, user_id')
    .in('conversation_id', conversationIds);

  const userIds = Array.from(new Set(((parts ?? []) as any[]).map((p: any) => p.user_id)));
  let profiles: any[] = [];
  if (userIds.length > 0) {
    const { data: profileData } = await (supabase as any)
      .from('profiles')
      .select('id, display_name, username')
      .in('id', userIds);
    profiles = profileData ?? [];
  }
  const nameMap = new Map(profiles.map((p: any) => [p.id, p.display_name || p.username || 'Unknown']));

  const result: Record<string, string> = {};
  for (const conv of conversations as any[]) {
    const convParts = ((parts ?? []) as any[]).filter((p) => p.conversation_id === conv.id);
    const other = convParts.find((p) => p.user_id !== userId);
    const name = other ? nameMap.get(other.user_id) : nameMap.get(userId);
    if (name && channelIds.includes(conv.channel_id)) {
      result[conv.channel_id] = name;
    }
  }
  return result;
}
