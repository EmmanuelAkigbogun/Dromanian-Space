import { supabase } from '@/lib/supabase';
import type {
  WorkspaceInviteLink,
  WorkspaceInviteLinkInfo,
  WorkspaceJoinRequest,
  JoinRequestStatus,
} from '@/types';

export async function getWorkspaceInviteLinkInfo(
  token: string,
): Promise<WorkspaceInviteLinkInfo | null> {
  const { data, error } = await supabase.rpc('get_workspace_invite_link_info' as never, {
    p_token: token,
  } as never);

  if (error || !data) return null;
  return data as WorkspaceInviteLinkInfo;
}

export async function createWorkspaceInviteLink(
  workspaceId: string,
): Promise<{ success: boolean; link?: WorkspaceInviteLink; error?: string }> {
  const { data, error } = await supabase.rpc('create_workspace_invite_link' as never, {
    p_workspace_id: workspaceId,
  } as never);

  if (error || !data) {
    return { success: false, error: 'Failed to create invite link.' };
  }
  const result = data as { success: boolean; link?: WorkspaceInviteLink; error?: string };
  return result;
}

export async function getWorkspaceInviteLinks(
  workspaceId: string,
): Promise<WorkspaceInviteLink[]> {
  const { data, error } = await supabase.rpc('get_workspace_invite_links' as never, {
    p_workspace_id: workspaceId,
  } as never);

  if (error || !data) return [];
  return data as WorkspaceInviteLink[];
}

export async function revokeWorkspaceInviteLink(
  linkId: string,
): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('revoke_workspace_invite_link' as never, {
    p_link_id: linkId,
  } as never);

  if (error || !data) {
    return { success: false, error: 'Failed to revoke invite link.' };
  }
  return data as { success: boolean; error?: string };
}

export async function submitWorkspaceJoinRequest(
  token: string,
): Promise<{ success: boolean; error?: string; workspaceName?: string }> {
  const { data, error } = await supabase.rpc('submit_workspace_join_request' as never, {
    p_token: token,
  } as never);

  if (error || !data) {
    return { success: false, error: 'Failed to send your request.' };
  }
  return data as { success: boolean; error?: string; workspaceName?: string };
}

export async function getWorkspaceJoinRequests(
  workspaceId: string,
): Promise<WorkspaceJoinRequest[]> {
  const { data, error } = await supabase.rpc('get_workspace_join_requests' as never, {
    p_workspace_id: workspaceId,
  } as never);

  if (error || !data) return [];
  return data as WorkspaceJoinRequest[];
}

export async function decideWorkspaceJoinRequest(
  requestId: string,
  accept: boolean,
): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('decide_workspace_join_request' as never, {
    p_request_id: requestId,
    p_accept: accept,
  } as never);

  if (error || !data) {
    return { success: false, error: 'Failed to update the request.' };
  }
  return data as { success: boolean; error?: string };
}

export type { JoinRequestStatus };
