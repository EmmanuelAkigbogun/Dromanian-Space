import { useState, useCallback, useMemo, useEffect } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { SearchInput } from '@/components/ui/SearchInput';
import { Avatar } from '@/components/ui/Avatar';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useConversation } from '@/hooks/useConversation';
import { getWorkspaceMembersWithProfiles } from '@/lib/channel';
import { getDisplayName } from '@/lib/message';
import type { Profile } from '@/types';
import styles from './CreateGroupDialog.module.css';

interface CreateGroupDialogProps {
  open: boolean;
  onClose: () => void;
}

interface MemberWithProfile {
  user_id: string;
  profile: Profile | null;
}

export function CreateGroupDialog({ open, onClose }: CreateGroupDialogProps) {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const { startGroup } = useConversation();
  const [query, setQuery] = useState('');
  const [groupName, setGroupName] = useState('');
  const [members, setMembers] = useState<MemberWithProfile[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    if (!open || !currentWorkspace) return;

    setIsLoadingMembers(true);
    getWorkspaceMembersWithProfiles(currentWorkspace.id)
      .then((data) => {
        setMembers(data.filter((m) => m.user_id !== userId && m.profile));
      })
      .finally(() => setIsLoadingMembers(false));
  }, [open, currentWorkspace, userId]);

  const filtered = useMemo(() => {
    if (!query.trim()) return members;
    const q = query.toLowerCase();
    return members.filter((m) => {
      if (!m.profile) return false;
      if (selectedIds.has(m.user_id)) return false;
      return (
        m.profile.display_name?.toLowerCase().includes(q) ||
        m.profile.username?.toLowerCase().includes(q) ||
        m.profile.email?.toLowerCase().includes(q)
      );
    });
  }, [members, query, selectedIds]);

  const selectedMembers = useMemo(() => {
    return members.filter((m) => selectedIds.has(m.user_id));
  }, [members, selectedIds]);

  const toggleMember = useCallback((userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }, []);

  const handleCreate = useCallback(async () => {
    if (!groupName.trim()) return;

    setIsCreating(true);
    await startGroup(Array.from(selectedIds), groupName.trim());
    setIsCreating(false);
    setGroupName('');
    setSelectedIds(new Set());
    setQuery('');
    onClose();
  }, [selectedIds, groupName, startGroup, onClose]);

  const handleClose = useCallback(() => {
    setGroupName('');
    setSelectedIds(new Set());
    setQuery('');
    onClose();
  }, [onClose]);

  const canCreate = groupName.trim().length > 0;
  const memberCountLabel = selectedIds.size === 0 ? 'Just Me' : `${selectedIds.size} members`;

  return (
    <Dialog open={open} onClose={handleClose} title="Create Group Conversation">
      <div className={styles.content}>
        <div className={styles.nameField}>
          <label className={styles.label} htmlFor="group-name">Group Name</label>
          <input
            id="group-name"
            type="text"
            className={styles.nameInput}
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="e.g., Project Alpha"
            maxLength={100}
          />
        </div>

        {selectedMembers.length > 0 && (
          <div className={styles.selectedSection}>
            <span className={styles.selectedLabel}>Selected ({selectedMembers.length})</span>
            <div className={styles.selectedList}>
              {selectedMembers.map((m) => {
                const profile = m.profile!;
                const name = getDisplayName(profile, m.user_id);
                return (
                  <button
                    key={m.user_id}
                    type="button"
                    className={styles.selectedChip}
                    onClick={() => toggleMember(m.user_id)}
                  >
                    <Avatar src={profile.avatar_url ?? undefined} name={name} size="xs" />
                    <span>{name}</span>
                    <span className={styles.removeIcon}>✕</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <SearchInput
          placeholder="Search members to add..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
          className={styles.searchInput}
        />

        <div className={styles.memberList}>
          {isLoadingMembers ? (
            <div className={styles.loading}>Loading members...</div>
          ) : filtered.length === 0 ? (
            <div className={styles.empty}>
              {query ? 'No members found' : 'No members available'}
            </div>
          ) : (
            filtered.map((member) => {
              const profile = member.profile!;
              const name = getDisplayName(profile, member.user_id);
              const isSelected = selectedIds.has(member.user_id);

              return (
                <button
                  key={member.user_id}
                  type="button"
                  className={`${styles.memberItem} ${isSelected ? styles.memberItemSelected : ''}`}
                  onClick={() => toggleMember(member.user_id)}
                >
                  <Avatar src={profile.avatar_url ?? undefined} name={name} size="sm" />
                  <div className={styles.memberInfo}>
                    <span className={styles.memberName}>{name}</span>
                    <span className={styles.memberEmail}>{profile.email}</span>
                  </div>
                  {isSelected && (
                    <svg className={styles.checkIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })
          )}
        </div>

        <button
          type="button"
          className={styles.createButton}
          disabled={!canCreate || isCreating}
          onClick={handleCreate}
        >
          {isCreating ? 'Creating...' : `Create Group (${memberCountLabel})`}
        </button>
      </div>
    </Dialog>
  );
}
