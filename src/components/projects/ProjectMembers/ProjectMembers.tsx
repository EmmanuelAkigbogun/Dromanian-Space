import { useState, useEffect, useCallback } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Spinner } from '@/components/ui/Spinner';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useToast } from '@/components/ui/Toast';
import type { ProjectMemberRole } from '@/types';
import styles from './ProjectMembers.module.css';

interface ProjectMembersProps {
  projectId: string;
  canManage?: boolean;
}

interface MemberWithProfile {
  id: string;
  user_id: string;
  role: ProjectMemberRole;
  created_at: string;
  display_name: string | null;
  avatar_url: string | null;
  email: string;
  is_implicit: boolean;
}

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];

export function ProjectMembers({ projectId, canManage = false }: ProjectMembersProps) {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const { toast } = useToast();
  const [members, setMembers] = useState<MemberWithProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ user_id: string; display_name: string; avatar_url: string | null; email: string }>>([]);
  const [removeTarget, setRemoveTarget] = useState<MemberWithProfile | null>(null);

  const fetchMembers = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);

    const { data, error } = await supabase
      .rpc('get_project_members', { p_project_id: projectId });

    if (error) {
      if (!silent) setIsLoading(false);
      return;
    }

    const memberRows = (data || []) as { id: string; user_id: string; role: string; created_at: string; display_name: string | null; avatar_url: string | null; email: string; is_implicit: boolean }[];

    setMembers(
      memberRows.map((m) => ({
        id: m.id,
        user_id: m.user_id,
        role: m.role as ProjectMemberRole,
        created_at: m.created_at,
        display_name: m.display_name ?? null,
        avatar_url: m.avatar_url ?? null,
        email: m.email ?? '',
        is_implicit: m.is_implicit ?? false,
      })),
    );
    if (!silent) setIsLoading(false);
  }, [projectId]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  useEffect(() => {
    const channel = supabase
      .channel(`project-members-${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'project_members', filter: `project_id=eq.${projectId}` },
        () => fetchMembers(true),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, fetchMembers]);

  const handleSearchMembers = useCallback(async (query: string) => {
    setSearchQuery(query);
    if (!query.trim() || !currentWorkspace?.id) {
      setSearchResults([]);
      return;
    }

    const memberUserIds = members.map((m) => m.user_id);

    const { data: wmData, error } = await supabase
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', currentWorkspace.id);

    if (error || !wmData) return;

    const filtered = (wmData as { user_id: string }[]).filter(
      (wm) => !memberUserIds.includes(wm.user_id)
    );

    if (filtered.length === 0) {
      setSearchResults([]);
      return;
    }

    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name, avatar_url, email')
      .in('id', filtered.map((m) => m.user_id));

    const profileMap = new Map<string, { display_name: string; avatar_url: string | null; email: string }>();
    (profiles as Array<{ id: string; display_name: string; avatar_url: string | null; email: string }> | null)?.forEach((p) => {
      profileMap.set(p.id, { display_name: p.display_name ?? '', avatar_url: p.avatar_url, email: p.email ?? '' });
    });

    const q = query.toLowerCase();
    setSearchResults(
      filtered
        .map((wm) => ({
          user_id: wm.user_id,
          display_name: profileMap.get(wm.user_id)?.display_name ?? '',
          avatar_url: profileMap.get(wm.user_id)?.avatar_url ?? null,
          email: profileMap.get(wm.user_id)?.email ?? '',
        }))
        .filter((r) => {
          return r.display_name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q);
        })
        .slice(0, 5),
    );
  }, [members, currentWorkspace?.id]);

  const handleAddMember = useCallback(async (userIdToAdd: string) => {
    const { error } = await supabase
      .rpc('add_project_member', { p_project_id: projectId, p_user_id: userIdToAdd });

    if (error) {
      toast({ description: 'Failed to add member', variant: 'error' });
      return;
    }

    toast({ description: 'Member added', variant: 'success' });
    setIsAdding(false);
    setSearchQuery('');
    setSearchResults([]);
    fetchMembers();
  }, [projectId, fetchMembers, toast]);

  const handleRoleChange = useCallback(async (memberId: string, newRole: ProjectMemberRole) => {
    const { error } = await supabase
      .rpc('update_project_member_role', { p_member_id: memberId, p_role: newRole });

    if (error) {
      toast({ description: 'Failed to change role', variant: 'error' });
      return;
    }

    setMembers((prev) =>
      prev.map((m) => (m.id === memberId ? { ...m, role: newRole } : m)),
    );
    toast({ description: 'Role updated', variant: 'success' });
  }, [toast]);

  const handleRemoveMember = useCallback(async (memberId: string) => {
    const { error } = await supabase
      .rpc('remove_project_member', { p_member_id: memberId });

    if (error) {
      toast({ description: 'Failed to remove member', variant: 'error' });
      setRemoveTarget(null);
      return;
    }

    setMembers((prev) => prev.filter((m) => m.id !== memberId));
    setRemoveTarget(null);
    toast({ description: 'Member removed', variant: 'success' });
  }, [toast]);

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <Spinner size="md" label="Loading members..." />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h3 className={styles.title}>Members ({members.length})</h3>
        {canManage && (
          <Button size="sm" onClick={() => setIsAdding(!isAdding)}>
            {isAdding ? 'Cancel' : 'Add Member'}
          </Button>
        )}
      </div>

      {isAdding && (
        <div className={styles.addForm}>
          <Input
            value={searchQuery}
            onChange={(e) => handleSearchMembers(e.target.value)}
            placeholder="Search workspace members..."
            autoFocus
          />
          {searchResults.length > 0 && (
            <div className={styles.searchResults}>
              {searchResults.map((result) => (
                <button
                  key={result.user_id}
                  type="button"
                  className={styles.searchResult}
                  onClick={() => handleAddMember(result.user_id)}
                >
                  <Avatar src={result.avatar_url || undefined} name={result.display_name} size="sm" />
                  <div className={styles.resultInfo}>
                    <span className={styles.resultName}>{result.display_name}</span>
                    <span className={styles.resultEmail}>{result.email}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={styles.memberList}>
        {members.map((member) => {
          const isCurrentUser = member.user_id === userId;

          return (
            <div key={member.id} className={styles.memberRow}>
              <Avatar
                src={member.avatar_url || undefined}
                name={member.display_name || member.email}
                size="md"
              />
              <div className={styles.memberInfo}>
                <span className={styles.memberName}>
                  {member.display_name || member.email}
                  {isCurrentUser && <span className={styles.youBadge}>(You)</span>}
                </span>
                <span className={styles.memberEmail}>{member.email}</span>
              </div>
              <div className={styles.memberActions}>
                <Badge variant={member.role === 'viewer' ? 'default' : 'primary'} size="sm" className={styles.roleBadge}>
                  {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                  {member.is_implicit && <span className={styles.implicitNote}> (all members)</span>}
                </Badge>
                {member.is_implicit && canManage && (
                  <button
                    type="button"
                    className={styles.promoteBtn}
                    onClick={() => handleAddMember(member.user_id)}
                    title="Add to project as a member so their role can be changed"
                  >
                    Add
                  </button>
                )}
                {!member.is_implicit && canManage && !isCurrentUser && (
                  <>
                    <Select
                      options={ROLE_OPTIONS}
                      value={member.role}
                      onChange={(e) => handleRoleChange(member.id, e.target.value as ProjectMemberRole)}
                      className={styles.roleSelect}
                    />
                    <button
                      type="button"
                      className={styles.removeBtn}
                      onClick={() => setRemoveTarget(member)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {members.length === 0 && (
        <div className={styles.emptyState}>
          <p className={styles.emptyText}>No members yet.</p>
        </div>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove member"
        message={removeTarget
          ? `Remove ${removeTarget.display_name || removeTarget.email} from this project? This action cannot be undone.`
          : ''}
        confirmLabel="Remove"
        danger
        onConfirm={() => handleRemoveMember(removeTarget!.id)}
        onClose={() => setRemoveTarget(null)}
      />
    </div>
  );
}
