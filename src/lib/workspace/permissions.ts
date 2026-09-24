import type { WorkspaceRole } from '@/types';

type Permission =
  | 'workspace:read'
  | 'workspace:update'
  | 'workspace:delete'
  | 'workspace:transfer_ownership'
  | 'workspace:invite_member'
  | 'workspace:remove_member'
  | 'workspace:change_role'
  | 'workspace:manage_settings'
  | 'workspace:upload_avatar'
  | 'channel:create'
  | 'channel:delete'
  | 'channel:read'
  | 'message:create'
  | 'message:edit_own'
  | 'message:delete_own'
  | 'message:delete_any'
  | 'message:read';

const ROLE_PERMISSIONS: Record<WorkspaceRole, Set<Permission>> = {
  owner: new Set([
    'workspace:read',
    'workspace:update',
    'workspace:delete',
    'workspace:transfer_ownership',
    'workspace:invite_member',
    'workspace:remove_member',
    'workspace:change_role',
    'workspace:manage_settings',
    'workspace:upload_avatar',
    'channel:create',
    'channel:delete',
    'channel:read',
    'message:create',
    'message:edit_own',
    'message:delete_own',
    'message:delete_any',
    'message:read',
  ]),
  admin: new Set([
    'workspace:read',
    'workspace:update',
    'workspace:invite_member',
    'workspace:remove_member',
    'workspace:change_role',
    'workspace:manage_settings',
    'workspace:upload_avatar',
    'channel:create',
    'channel:delete',
    'channel:read',
    'message:create',
    'message:edit_own',
    'message:delete_own',
    'message:delete_any',
    'message:read',
  ]),
  member: new Set([
    'workspace:read',
    'channel:create',
    'channel:read',
    'message:create',
    'message:edit_own',
    'message:delete_own',
    'message:read',
  ]),
};

export function hasPermission(role: WorkspaceRole | null, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function hasAnyPermission(role: WorkspaceRole | null, permissions: Permission[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

export function hasAllPermissions(role: WorkspaceRole | null, permissions: Permission[]): boolean {
  return permissions.every((p) => hasPermission(role, p));
}

// Convenience predicates for common checks
export function canUpdateWorkspace(role: WorkspaceRole | null): boolean {
  return hasPermission(role, 'workspace:update');
}

export function canDeleteWorkspace(role: WorkspaceRole | null): boolean {
  return hasPermission(role, 'workspace:delete');
}

export function canTransferOwnership(role: WorkspaceRole | null): boolean {
  return hasPermission(role, 'workspace:transfer_ownership');
}

export function canInviteMembers(role: WorkspaceRole | null): boolean {
  return hasPermission(role, 'workspace:invite_member');
}

export function canRemoveMembers(role: WorkspaceRole | null): boolean {
  return hasPermission(role, 'workspace:remove_member');
}

export function canChangeRoles(role: WorkspaceRole | null): boolean {
  return hasPermission(role, 'workspace:change_role');
}

export function canManageSettings(role: WorkspaceRole | null): boolean {
  return hasPermission(role, 'workspace:manage_settings');
}

export function canUploadAvatar(role: WorkspaceRole | null): boolean {
  return hasPermission(role, 'workspace:upload_avatar');
}

export function canCreateChannel(role: WorkspaceRole | null): boolean {
  return hasPermission(role, 'channel:create');
}

export function canDeleteChannel(role: WorkspaceRole | null): boolean {
  return hasPermission(role, 'channel:delete');
}

export function canCreateMessage(role: WorkspaceRole | null): boolean {
  return hasPermission(role, 'message:create');
}

export function canDeleteAnyMessage(role: WorkspaceRole | null): boolean {
  return hasPermission(role, 'message:delete_any');
}

export type { Permission };
