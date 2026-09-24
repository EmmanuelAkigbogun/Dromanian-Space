import { supabase } from '@/lib/supabase';
import type { CallSession, CallParticipant } from '@/types';

const db = supabase as any;

export async function createCallSession(
  workspaceId: string,
  createdBy: string,
  callType: 'direct' | 'group' | 'channel',
  options?: { channelId?: string; conversationId?: string; withVideo?: boolean },
): Promise<CallSession | null> {
  const { data, error } = await db
    .from('call_sessions')
    .insert({
      workspace_id: workspaceId,
      channel_id: options?.channelId ?? null,
      conversation_id: options?.conversationId ?? null,
      call_type: callType,
      with_video: options?.withVideo ?? false,
      created_by: createdBy,
      status: 'ringing',
    })
    .select()
    .single();

  if (error || !data) return null;
  return data as CallSession;
}

export async function addCallParticipant(
  callId: string,
  userId: string,
): Promise<CallParticipant | null> {
  const { data, error } = await db
    .from('call_participants')
    .upsert({
      call_id: callId,
      user_id: userId,
      status: 'ringing',
    }, { onConflict: 'call_id,user_id' })
    .select()
    .single();

  if (error || !data) return null;
  return data as CallParticipant;
}

export async function updateCallParticipantStatus(
  callId: string,
  userId: string,
  status: CallParticipant['status'],
): Promise<boolean> {
  const updates: Record<string, unknown> = { status };
  if (status === 'connected') updates.joined_at = new Date().toISOString();
  if (status === 'left' || status === 'disconnected') updates.left_at = new Date().toISOString();

  const { error } = await db
    .from('call_participants')
    .update(updates)
    .eq('call_id', callId)
    .eq('user_id', userId);

  return !error;
}

export async function updateCallParticipantMuted(
  callId: string,
  userId: string,
  isMuted: boolean,
): Promise<boolean> {
  const { error } = await db
    .from('call_participants')
    .update({ is_muted: isMuted })
    .eq('call_id', callId)
    .eq('user_id', userId);

  return !error;
}

export async function answerCall(callId: string): Promise<boolean> {
  const { error } = await db
    .from('call_sessions')
    .update({ status: 'active', started_at: new Date().toISOString(), answered_at: new Date().toISOString() })
    .eq('id', callId);

  return !error;
}

export async function endCall(callId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data: session } = await db
    .from('call_sessions')
    .select('answered_at')
    .eq('id', callId)
    .single();

  const duration = session?.answered_at
    ? Math.floor((Date.now() - new Date(session.answered_at).getTime()) / 1000)
    : 0;

  const { error } = await db
    .from('call_sessions')
    .update({ status: 'ended', ended_at: now, duration })
    .eq('id', callId);

  return !error;
}

export async function declineCall(callId: string): Promise<boolean> {
  const { error } = await db
    .from('call_sessions')
    .update({ status: 'declined', ended_at: new Date().toISOString() })
    .eq('id', callId);

  return !error;
}

export async function cancelCall(callId: string): Promise<boolean> {
  const { error } = await db
    .from('call_sessions')
    .update({ status: 'cancelled', ended_at: new Date().toISOString() })
    .eq('id', callId);

  return !error;
}

export async function getCallSession(callId: string): Promise<CallSession | null> {
  const { data, error } = await db
    .from('call_sessions')
    .select('*')
    .eq('id', callId)
    .single();

  if (error || !data) return null;
  return data as CallSession;
}

export async function getCallParticipants(callId: string): Promise<CallParticipant[]> {
  const { data, error } = await db
    .from('call_participants')
    .select('*')
    .eq('call_id', callId)
    .order('created_at', { ascending: true });

  if (error || !data) return [];
  return data as CallParticipant[];
}

// FIX: previously ignored `userId` entirely and returned every ringing/active
// call in the whole workspace. Now scoped to calls the user actually participates in,
// same pattern as getCallHistory below.
export async function getUserActiveCalls(userId: string, workspaceId: string): Promise<CallSession[]> {
  const { data: participations, error: partErr } = await db
    .from('call_participants')
    .select('call_id')
    .eq('user_id', userId);

  if (partErr || !participations || participations.length === 0) return [];

  const callIds = participations.map((p: any) => p.call_id);

  const { data, error } = await db
    .from('call_sessions')
    .select('*')
    .in('id', callIds)
    .eq('workspace_id', workspaceId)
    .in('status', ['ringing', 'active'])
    .order('created_at', { ascending: false });

  if (error || !data) return [];
  return data as CallSession[];
}

export async function getCallHistory(
  userId: string,
  workspaceId: string,
  options?: { limit?: number; offset?: number },
): Promise<CallSession[]> {
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;

  const { data: participations, error: partErr } = await db
    .from('call_participants')
    .select('call_id')
    .eq('user_id', userId);

  if (partErr || !participations || participations.length === 0) return [];

  const callIds = participations.map((p: any) => p.call_id);

  const { data, error } = await db
    .from('call_sessions')
    .select('*')
    .in('id', callIds)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error || !data) return [];
  return data as CallSession[];
}

export async function deleteCallHistory(callId: string, userId: string): Promise<boolean> {
  const { data: session } = await db
    .from('call_sessions')
    .select('created_by')
    .eq('id', callId)
    .maybeSingle();

  if (session && session.created_by === userId) {
    await db
      .from('call_participants')
      .delete()
      .eq('call_id', callId);

    const { error } = await db
      .from('call_sessions')
      .delete()
      .eq('id', callId);

    return !error;
  }

  const { error } = await db
    .from('call_participants')
    .delete()
    .eq('call_id', callId)
    .eq('user_id', userId);

  return !error;
}