import { supabase } from '@/lib/supabase';
import { createInvitationNotification } from '@/features/notifications/service';
import type { Workspace, WorkspaceMember, WorkspaceRole, Invitation, InvitationRole, InvitationStatus, Profile } from '@/types';

export async function getUserWorkspaces(userId: string): Promise<Workspace[]> {
  const { data, error } = await supabase
    .from('workspace_members')
    .select('workspaces(*)')
    .eq('user_id', userId);

  if (error) {
    console.error('getUserWorkspaces error:', error.message, error.code, error.details);
    throw new Error(error.message);
  }
  if (!data) return [];
  return data.map((member) => member.workspaces as unknown as Workspace);
}

export async function getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  const { data, error } = await supabase
    .from('workspaces')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error || !data) return null;
  return data as Workspace;
}

export async function getWorkspaceById(id: string): Promise<Workspace | null> {
  const { data, error } = await supabase
    .from('workspaces')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) return null;
  return data as Workspace;
}

export async function createWorkspace(
  name: string,
  slug: string,
  ownerId: string,
  description?: string,
): Promise<Workspace | null> {
  const { data, error } = await supabase.rpc('create_workspace_with_owner' as any, {
    p_name: name,
    p_slug: slug,
    p_owner_id: ownerId,
    p_description: description ?? null,
  });

  if (error || !data) return null;
  return data as Workspace;
}

export async function updateWorkspace(
  workspaceId: string,
  updates: Partial<Pick<Workspace, 'name' | 'description' | 'avatar_url'>>,
): Promise<Workspace | null> {
  const { data, error } = await supabase
    .from('workspaces')
    .update(updates)
    .eq('id', workspaceId)
    .select()
    .single();

  if (error || !data) return null;
  return data as Workspace;
}

export async function deleteWorkspace(workspaceId: string): Promise<boolean> {
  await removeWorkspaceAvatar(workspaceId);
  const { error } = await supabase
    .from('workspaces')
    .delete()
    .eq('id', workspaceId);

  return !error;
}

export async function getWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const { data, error } = await supabase
    .from('workspace_members')
    .select('*')
    .eq('workspace_id', workspaceId);

  if (error || !data) return [];
  return data as WorkspaceMember[];
}

export async function addWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole = 'member',
): Promise<WorkspaceMember | null> {
  const { data, error } = await supabase
    .from('workspace_members')
    .insert({
      workspace_id: workspaceId,
      user_id: userId,
      role,
    })
    .select()
    .single();

  if (error || !data) return null;
  return data as WorkspaceMember;
}

export async function removeWorkspaceMember(
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('workspace_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);

  return !error;
}

export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<WorkspaceMember | null> {
  const { data, error } = await supabase
    .from('workspace_members')
    .update({ role })
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error || !data) return null;
  return data as WorkspaceMember;
}

export async function getUserWorkspaceRole(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const { data, error } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .single();

  if (error || !data) return null;
  return data.role as WorkspaceRole;
}

// --- Invitations ---

export async function createInvitation(
  workspaceId: string,
  email: string,
  invitedBy: string,
  role: InvitationRole = 'member',
): Promise<{ invitation: Invitation | null; error?: string; recipientHasAccount?: boolean; resend?: boolean }> {
  const normalizedEmail = email.toLowerCase().trim();

  let invitationId: string | null = null;
  let resend = false;

  const { data: existing } = await supabase
    .from('invitations')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('email', normalizedEmail)
    .eq('status', 'pending')
    .maybeSingle();

  if (existing) {
    resend = true;
    const { error: updateError } = await supabase
      .from('invitations')
      .update({ role, invited_by: invitedBy, created_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (updateError) return { invitation: null, error: 'Failed to update invitation.' };
    invitationId = existing.id;
  } else {
    // Remove any old non-pending invitation (accepted/declined/expired/cancelled)
    // so the UNIQUE(workspace_id, email) constraint won't block re-invites
    await supabase
      .from('invitations')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('email', normalizedEmail)
      .neq('status', 'pending');

    const { data: memberCheck } = await supabase
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', invitedBy)
      .single();

    if (!memberCheck) {
      return { invitation: null, error: 'You are not a member of this workspace.' };
    }

    const { data, error } = await supabase
      .from('invitations')
      .insert({
        workspace_id: workspaceId,
        email: normalizedEmail,
        invited_by: invitedBy,
        role,
      })
      .select()
      .single();

    if (error || !data) {
      if (error?.code === '23505') {
        const { data: raced } = await supabase
          .from('invitations')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('email', normalizedEmail)
          .eq('status', 'pending')
          .maybeSingle();
        if (!raced) return { invitation: null, error: 'Failed to create invitation.' };
        resend = true;
        invitationId = raced.id;
      } else {
        return { invitation: null, error: 'Failed to create invitation.' };
      }
    } else {
      invitationId = data.id;
    }
  }

  if (!invitationId) return { invitation: null, error: 'Failed to create invitation.' };

  const { data: invitation } = await supabase
    .from('invitations')
    .select('*')
    .eq('id', invitationId)
    .single();

  if (!invitation) return { invitation: null, error: 'Failed to create invitation.' };

  let recipientHasAccount = false;

  try {
    const [workspaceResult, inviterProfileResult, invitedProfileResult] = await Promise.all([
      supabase.from('workspaces').select('name').eq('id', workspaceId).single(),
      supabase.from('profiles').select('display_name, username').eq('id', invitedBy).single(),
      supabase.rpc('get_user_id_by_email', { p_email: normalizedEmail }),
    ]);

    const invitedUserId = invitedProfileResult.data?.[0]?.user_id;
    recipientHasAccount = !!invitedUserId;

    if (invitedUserId && workspaceResult.data && inviterProfileResult.data) {
      const inviterName = inviterProfileResult.data.display_name || inviterProfileResult.data.username || 'Someone';
      const workspaceName = workspaceResult.data.name;
      await createInvitationNotification(invitedUserId, workspaceName, inviterName, role, {
        workspaceId,
        actorId: invitedBy,
      });
    }
  } catch (err) {
    console.error('Failed to create invitation notification:', err);
  }

  return { invitation: invitation as Invitation, recipientHasAccount, resend };
}

export async function getWorkspaceInvitations(
  workspaceId: string,
  status?: InvitationStatus,
): Promise<Invitation[]> {
  let query = supabase
    .from('invitations')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error || !data) return [];
  return data as Invitation[];
}

export async function getPendingInvitations(workspaceId: string): Promise<Invitation[]> {
  return getWorkspaceInvitations(workspaceId, 'pending');
}

export async function acceptInvitation(
  invitationId: string,
  userId: string,
  userEmail?: string,
): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('accept_workspace_invitation' as any, {
    p_invitation_id: invitationId,
    p_user_id: userId,
    p_user_email: userEmail ?? null,
  });

  if (error) {
    return { success: false, error: 'An unexpected error occurred.' };
  }

  const result = data as { success: boolean; error?: string };
  return result;
}

export async function declineInvitation(invitationId: string): Promise<boolean> {
  const { error } = await supabase
    .from('invitations')
    .update({ status: 'declined' })
    .eq('id', invitationId)
    .eq('status', 'pending');

  return !error;
}

export async function cancelInvitation(invitationId: string): Promise<boolean> {
  const { error } = await supabase
    .from('invitations')
    .update({ status: 'cancelled' })
    .eq('id', invitationId)
    .eq('status', 'pending');

  return !error;
}

export async function deleteInvitation(invitationId: string): Promise<boolean> {
  const { error } = await supabase
    .from('invitations')
    .delete()
    .eq('id', invitationId);

  return !error;
}

export async function getPendingInvitationByToken(
  token: string,
): Promise<Invitation | null> {
  const { data, error } = await supabase
    .from('invitations')
    .select('*')
    .eq('token', token)
    .eq('status', 'pending')
    .single();

  if (error || !data) return null;

  if (new Date(data.expires_at) < new Date()) {
    await supabase
      .from('invitations')
      .update({ status: 'expired' })
      .eq('id', data.id);
    return null;
  }

  return data as Invitation;
}

export async function resendInvitation(
  invitationId: string,
): Promise<Invitation | null> {
  const { data: invitation, error: fetchError } = await supabase
    .from('invitations')
    .select('*')
    .eq('id', invitationId)
    .in('status', ['pending', 'cancelled', 'expired'])
    .single();

  if (fetchError || !invitation) return null;

  const newToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('invitations')
    .update({
      status: 'pending',
      token: newToken,
      expires_at: newExpiresAt,
    })
    .eq('id', invitationId)
    .select()
    .single();

  if (error || !data) return null;
  return data as Invitation;
}

export async function getUserInvitations(userId: string): Promise<Invitation[]> {
  const { data, error } = await supabase
    .from('invitations')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error || !data) return [];
  return data as Invitation[];
}

export interface UserInvitation extends Invitation {
  workspace: Workspace | null;
  inviterProfile: Profile | null;
}

export async function getUserInvitationsByEmail(email: string): Promise<UserInvitation[]> {
  const normalizedEmail = email.toLowerCase().trim();

  const { data, error } = await supabase
    .from('invitations')
    .select('*')
    .ilike('email', normalizedEmail)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch invitations:', error.message, error.code);
    return [];
  }
  if (!data) return [];

  const invitations = data as Invitation[];
  if (invitations.length === 0) return [];

  const workspaceIds = [...new Set(invitations.map((i) => i.workspace_id))];
  const inviterIds = [...new Set(invitations.map((i) => i.invited_by))];

  const workspaceMap = new Map<string, Workspace>();
  const profileMap = new Map<string, Profile>();

  try {
    const [workspaceResult, profileResult] = await Promise.all([
      workspaceIds.length > 0
        ? supabase.from('workspaces').select('*').in('id', workspaceIds)
        : { data: null, error: null },
      inviterIds.length > 0
        ? supabase.from('profiles').select('*').in('id', inviterIds)
        : { data: null, error: null },
    ]);

    if (workspaceResult.data) {
      for (const w of workspaceResult.data as Workspace[]) {
        workspaceMap.set(w.id, w);
      }
    }

    if (profileResult.data) {
      for (const p of profileResult.data as Profile[]) {
        profileMap.set(p.id, p);
      }
    }
  } catch (err) {
    console.error('Failed to fetch invitation details:', err);
  }

  return invitations.map((inv) => ({
    ...inv,
    workspace: workspaceMap.get(inv.workspace_id) ?? null,
    inviterProfile: profileMap.get(inv.invited_by) ?? null,
  }));
}

// --- Workspace Avatar ---

export async function removeWorkspaceAvatar(workspaceId: string): Promise<void> {
  const { data } = await supabase.storage.from('avatars').list(`${workspaceId}`);
  if (data && data.length > 0) {
    const paths = data.map((f) => `${workspaceId}/${f.name}`);
    await supabase.storage.from('avatars').remove(paths);
  }
}

export async function uploadWorkspaceAvatar(
  workspaceId: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<string> {
  await removeWorkspaceAvatar(workspaceId);

  const fileExt = file.name.split('.').pop();
  const filePath = `${workspaceId}/avatar.${fileExt}`;

  if (onProgress && typeof XMLHttpRequest !== 'undefined') {
    const ok = await uploadWorkspaceAvatarWithProgress(filePath, file, onProgress);
    if (!ok) throw new Error('Upload failed');

    const { data: urlData } = supabase.storage
      .from('avatars')
      .getPublicUrl(filePath);

    return `${urlData.publicUrl}?v=${Date.now()}`;
  }

  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(filePath, file, { upsert: true });

  if (uploadError) throw uploadError;

  const { data: urlData } = supabase.storage
    .from('avatars')
    .getPublicUrl(filePath);

  return `${urlData.publicUrl}?v=${Date.now()}`;
}

function uploadWorkspaceAvatarWithProgress(
  filePath: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sc = supabase as unknown as { supabaseUrl: string; supabaseKey: string };
    const form = new FormData();
    form.append('cacheControl', '3600');
    form.append('', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${sc.supabaseUrl}/storage/v1/object/avatars/${filePath}`);
    xhr.setRequestHeader('apikey', sc.supabaseKey);
    supabase.auth.getSession().then(({ data: { session } }) => {
      const token = session?.access_token ?? sc.supabaseKey;
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
        }
      };
      xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
      xhr.onerror = () => resolve(false);
      xhr.onabort = () => resolve(false);
      xhr.send(form);
    });
  });
}

// --- Transfer Ownership ---

export async function transferOwnership(
  workspaceId: string,
  currentOwnerId: string,
  newOwnerId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('transfer_workspace_ownership' as any, {
    p_workspace_id: workspaceId,
    p_current_owner_id: currentOwnerId,
    p_new_owner_id: newOwnerId,
  });

  if (error) return false;
  return data === true;
}

// --- Self-Protection & Validation ---

export async function getOwnerCount(workspaceId: string): Promise<number> {
  const { count, error } = await supabase
    .from('workspace_members')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('role', 'owner');

  if (error) return 0;
  return count ?? 0;
}

export async function canUserLeaveWorkspace(
  workspaceId: string,
  userId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const role = await getUserWorkspaceRole(workspaceId, userId);
  if (!role) {
    return { allowed: false, reason: 'You are not a member of this workspace.' };
  }
  if (role === 'owner') {
    const ownerCount = await getOwnerCount(workspaceId);
    if (ownerCount <= 1) {
      return { allowed: false, reason: 'You are the only owner. Transfer ownership before leaving.' };
    }
  }
  return { allowed: true };
}

export async function leaveWorkspace(
  workspaceId: string,
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  const check = await canUserLeaveWorkspace(workspaceId, userId);
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  const { error } = await supabase
    .from('workspace_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);

  if (error) return { success: false, error: 'Failed to leave workspace.' };
  return { success: true };
}

export async function validateRemoveMember(
  workspaceId: string,
  targetUserId: string,
  callerUserId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const { data, error } = await supabase.rpc('remove_workspace_member' as any, {
    p_workspace_id: workspaceId,
    p_target_user_id: targetUserId,
    p_caller_id: callerUserId,
  });

  if (error) {
    return { allowed: false, reason: 'An unexpected error occurred.' };
  }

  return data as { allowed: boolean; reason?: string };
}

export async function validateRoleChange(
  workspaceId: string,
  targetUserId: string,
  callerUserId: string,
  newRole: WorkspaceRole,
): Promise<{ allowed: boolean; reason?: string }> {
  const { data, error } = await supabase.rpc('change_member_role' as any, {
    p_workspace_id: workspaceId,
    p_target_user_id: targetUserId,
    p_new_role: newRole,
    p_caller_id: callerUserId,
  });

  if (error) {
    return { allowed: false, reason: 'An unexpected error occurred.' };
  }

  return data as { allowed: boolean; reason?: string };
}
