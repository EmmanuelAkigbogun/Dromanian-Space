import type { UserRole } from '@/types/auth';

const ROLE_HIERARCHY: Record<UserRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  guest: 1,
};

export function hasMinimumRole(userRole: UserRole | null, requiredRole: UserRole): boolean {
  if (!userRole) return false;
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

export function hasExactRole(userRole: UserRole | null, role: UserRole): boolean {
  return userRole === role;
}

export function isAdmin(userRole: UserRole | null): boolean {
  return userRole === 'admin' || userRole === 'owner';
}

export function isOwner(userRole: UserRole | null): boolean {
  return userRole === 'owner';
}

export function canManageUsers(userRole: UserRole | null): boolean {
  return hasMinimumRole(userRole, 'admin');
}

export function canManageSettings(userRole: UserRole | null): boolean {
  return hasMinimumRole(userRole, 'admin');
}

export function canDeleteContent(userRole: UserRole | null): boolean {
  return hasMinimumRole(userRole, 'member');
}

export function canCreateContent(userRole: UserRole | null): boolean {
  return hasMinimumRole(userRole, 'member');
}
