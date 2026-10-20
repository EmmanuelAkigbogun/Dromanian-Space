import { platform } from '@/lib/platform';
import type { CallSession, CallParticipant } from '@/types';

const db = platform as any;

export async function createCallSession(
  workspaceId: string,
  _createdBy: string,
  callType: 'direct' | 'group' | 'channel',
  options?: { channelId?: string; conversationId?: string; withVideo?: boolean; targetUserIds?: string[] },
): Promise<{ session: CallSession; participants: CallParticipant[] } | null> {
  const response = await fetch('/api/calls', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, callType, channelId: options?.channelId, conversationId: options?.conversationId, withVideo: options?.withVideo ?? false, targetUserIds: options?.targetUserIds ?? [] }),
  });
  if (!response.ok) return null;
  const payload = await response.json() as { session: CallSession; participants: CallParticipant[] };
  return payload;
}

export async function updateCallParticipantMuted(
  callId: string,
  isMuted: boolean,
): Promise<boolean> {
  return (await fetch(`/api/calls/${callId}/participant`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isMuted }),
  })).ok;
}

export async function answerCall(callId: string): Promise<boolean> {
  return (await fetch(`/api/calls/${callId}/answer`, { method: 'POST', credentials: 'same-origin' })).ok;
}

export async function endCall(callId: string): Promise<boolean> {
  return (await fetch(`/api/calls/${callId}/end`, { method: 'POST', credentials: 'same-origin' })).ok;
}

export async function declineCall(callId: string): Promise<boolean> {
  return (await fetch(`/api/calls/${callId}/decline`, { method: 'POST', credentials: 'same-origin' })).ok;
}

export async function cancelCall(callId: string): Promise<boolean> {
  return (await fetch(`/api/calls/${callId}/cancel`, { method: 'POST', credentials: 'same-origin' })).ok;
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
  void userId;
  return (await fetch(`/api/calls/${callId}/history`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })).ok;
}
