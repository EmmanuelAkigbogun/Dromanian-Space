import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useToast } from '@/components/ui/Toast';
import { supabase } from '@/lib/supabase';
import { getWorkspaceMembers, updateMemberRole, removeWorkspaceMember, validateRemoveMember, validateRoleChange } from '@/lib/workspace';
import { getProfilesByUserIds } from '@/lib/profile';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { SearchInput } from '@/components/ui/SearchInput';
import { Spinner } from '@/components/ui/Spinner';
import { MemberActionsMenu } from './MemberActionsMenu';
import { RemoveMemberConfirmDialog } from '../RemoveMemberConfirmDialog';
import { RoleChangeDialog } from '../RoleChangeDialog';
import type { WorkspaceMember, Profile, WorkspaceRole } from '@/types';
import styles from './MembersList.module.css';

interface MemberWithProfile extends WorkspaceMember {
  profile: Profile | null;
}

type SortField = 'name' | 'role' | 'joined';
type SortDirection = 'asc' | 'desc';
type RoleFilter = 'all' | WorkspaceRole;

const ROLE_ORDER: Record<WorkspaceRole, number> = { owner: 0, admin: 1, member: 2 };

export function MembersList() {
  const { userId } = useAuth();
  const { currentWorkspace, isAdmin, isOwner } = useWorkspace();
  const { toast } = useToast();

  const [members, setMembers] = useState<MemberWithProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [sortField, setSortField] = useState<SortField>('role');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const [removeTarget, setRemoveTarget] = useState<MemberWithProfile | null>(null);
  const [roleChangeTarget, setRoleChangeTarget] = useState<MemberWithProfile | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const fetchMembers = useCallback(async (showLoading = true) => {
    if (!currentWorkspace) return;
    if (showLoading) setIsLoading(true);
    const rawMembers = await getWorkspaceMembers(currentWorkspace.id);
    const userIds = rawMembers.map((m) => m.user_id);
    const profiles = await getProfilesByUserIds(userIds);
    const profileMap = new Map(profiles.map((p) => [p.id, p]));
    const membersWithProfiles = rawMembers.map((member) => ({
      ...member,
      profile: profileMap.get(member.user_id) ?? null,
    }));
    setMembers(membersWithProfiles);
    if (showLoading) setIsLoading(false);
  }, [currentWorkspace]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  useEffect(() => {
    if (!currentWorkspace) return;
    const channel = supabase
      .channel(`workspace-members:${currentWorkspace.id}:${Math.random().toString(36).slice(2, 9)}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'workspace_members',
          filter: `workspace_id=eq.${currentWorkspace.id}`,
        },
        () => {
          fetchMembers(false);
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'workspace_members',
          filter: `workspace_id=eq.${currentWorkspace.id}`,
        },
        () => {
          fetchMembers(false);
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'workspace_members',
          filter: `workspace_id=eq.${currentWorkspace.id}`,
        },
        () => {
          fetchMembers(false);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentWorkspace, fetchMembers]);

  const filteredAndSorted = useMemo(() => {
    let result = members.filter((member) => {
      if (roleFilter !== 'all' && member.role !== roleFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const name = member.profile?.display_name?.toLowerCase() || '';
        const username = member.profile?.username?.toLowerCase() || '';
        const email = member.profile?.email?.toLowerCase() || '';
        if (!name.includes(q) && !username.includes(q) && !email.includes(q)) return false;
      }
      return true;
    });

    result.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'name') {
        const nameA = a.profile?.display_name || a.profile?.username || '';
        const nameB = b.profile?.display_name || b.profile?.username || '';
        cmp = nameA.localeCompare(nameB);
      } else if (sortField === 'role') {
        cmp = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
      } else {
        cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [members, searchQuery, roleFilter, sortField, sortDirection]);

  async function handleRoleChange(memberId: string, newRole: WorkspaceRole) {
    if (!currentWorkspace || !userId) return;
    setIsProcessing(true);
    try {
      const validation = await validateRoleChange(currentWorkspace.id, memberId, userId, newRole);
      if (!validation.allowed) {
        toast({ variant: 'error', description: validation.reason ?? '' });
        return;
      }
      const result = await updateMemberRole(currentWorkspace.id, memberId, newRole);
      if (result) {
        setMembers((prev) =>
          prev.map((m) => (m.user_id === memberId ? { ...m, role: newRole } : m)),
        );
        toast({ variant: 'success', description: 'Role updated.' });
      } else {
        toast({ variant: 'error', description: 'Failed to update role.' });
      }
    } catch {
      toast({ variant: 'error', description: 'An unexpected error occurred.' });
    } finally {
      setIsProcessing(false);
      setRoleChangeTarget(null);
    }
  }

  async function handleRemove(memberId: string) {
    if (!currentWorkspace || !userId) return;
    setIsProcessing(true);
    try {
      const validation = await validateRemoveMember(currentWorkspace.id, memberId, userId);
      if (!validation.allowed) {
        toast({ variant: 'error', description: validation.reason ?? '' });
        return;
      }
      const success = await removeWorkspaceMember(currentWorkspace.id, memberId);
      if (success) {
        setMembers((prev) => prev.filter((m) => m.user_id !== memberId));
        toast({ variant: 'success', description: 'Member removed.' });
      } else {
        toast({ variant: 'error', description: 'Failed to remove member.' });
      }
    } catch {
      toast({ variant: 'error', description: 'An unexpected error occurred.' });
    } finally {
      setIsProcessing(false);
      setRemoveTarget(null);
    }
  }

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div>
      <div className={styles.toolbar}>
        <SearchInput
          placeholder="Search members..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onClear={() => setSearchQuery('')}
          className={styles.searchInput}
        />
        <div className={styles.filters}>
          <select
            className={styles.filterSelect}
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
            aria-label="Filter by role"
          >
            <option value="all">All roles</option>
            <option value="owner">Owner</option>
            <option value="admin">Admin</option>
            <option value="member">Member</option>
          </select>
          <select
            className={styles.filterSelect}
            value={`${sortField}-${sortDirection}`}
            onChange={(e) => {
              const [field, dir] = e.target.value.split('-');
              setSortField(field as SortField);
              setSortDirection(dir as SortDirection);
            }}
            aria-label="Sort members"
          >
            <option value="role-asc">Role</option>
            <option value="name-asc">Name A-Z</option>
            <option value="name-desc">Name Z-A</option>
            <option value="joined-asc">Oldest first</option>
            <option value="joined-desc">Newest first</option>
          </select>
        </div>
      </div>

      {filteredAndSorted.length === 0 ? (
        <p className={styles.empty}>
          {searchQuery || roleFilter !== 'all' ? 'No members match your filters.' : 'No members found.'}
        </p>
      ) : (
        <ul className={styles.list}>
          {filteredAndSorted.map((member) => {
            const isCurrentUser = member.user_id === userId;
            const isMemberOwner = member.role === 'owner';
            const canManage = (isAdmin || isOwner) && !isCurrentUser && !isMemberOwner;
            const canManageAsAdmin = isOwner && !isCurrentUser && member.role === 'admin';

            return (
              <li key={member.id} className={styles.member}>
                <div className={styles.memberInfo}>
                  <Avatar
                    src={member.profile?.avatar_url ?? undefined}
                    name={member.profile?.display_name || member.profile?.username || 'U'}
                    size="md"
                  />
                  <div className={styles.memberDetails}>
                    <span className={styles.memberName}>
                      {member.profile?.display_name || member.profile?.username || 'Unknown'}
                      {isCurrentUser && <span className={styles.you}>(you)</span>}
                    </span>
                    <span className={styles.memberEmail}>{member.profile?.email}</span>
                  </div>
                </div>
                <div className={styles.memberActions}>
                  <Badge variant={isMemberOwner ? 'primary' : member.role === 'admin' ? 'warning' : 'default'}>
                    {member.role}
                  </Badge>
                  {(canManage || canManageAsAdmin) && (
                    <MemberActionsMenu
                      currentRole={member.role as 'admin' | 'member'}
                      onRoleChange={(_role) => {
                        setRoleChangeTarget(member);
                      }}
                      onRemove={() => setRemoveTarget(member)}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <RemoveMemberConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && handleRemove(removeTarget.user_id)}
        memberName={removeTarget?.profile?.display_name || removeTarget?.profile?.username || 'Unknown'}
        memberEmail={removeTarget?.profile?.email || ''}
        isLoading={isProcessing}
      />

      <RoleChangeDialog
        open={roleChangeTarget !== null}
        onClose={() => setRoleChangeTarget(null)}
        onConfirm={(newRole) => roleChangeTarget && handleRoleChange(roleChangeTarget.user_id, newRole)}
        memberName={roleChangeTarget?.profile?.display_name || roleChangeTarget?.profile?.username || 'Unknown'}
        memberEmail={roleChangeTarget?.profile?.email || ''}
        memberAvatar={roleChangeTarget?.profile?.avatar_url}
        currentRole={roleChangeTarget?.role || 'member'}
        isLoading={isProcessing}
      />
    </div>
  );
}
