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
import styles from './StartDmDialog.module.css';

interface StartDmDialogProps {
  open: boolean;
  onClose: () => void;
}

interface MemberWithProfile {
  user_id: string;
  profile: Profile | null;
}

export function StartDmDialog({ open, onClose }: StartDmDialogProps) {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const { startDm } = useConversation();
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState<MemberWithProfile[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    if (!open || !currentWorkspace) return;

    setIsLoadingMembers(true);
    getWorkspaceMembersWithProfiles(currentWorkspace.id)
      .then((data) => {
        setMembers(data.filter((m) => m.profile));
      })
      .finally(() => setIsLoadingMembers(false));
  }, [open, currentWorkspace, userId]);

  const filtered = useMemo(() => {
    if (!query.trim()) return members;
    const q = query.toLowerCase();
    return members.filter((m) => {
      if (!m.profile) return false;
      return (
        m.profile.display_name?.toLowerCase().includes(q) ||
        m.profile.username?.toLowerCase().includes(q) ||
        m.profile.email?.toLowerCase().includes(q)
      );
    });
  }, [members, query]);

  const handleStart = useCallback(async (otherUserId: string) => {
    setIsCreating(true);
    await startDm(otherUserId);
    setIsCreating(false);
    setQuery('');
    onClose();
  }, [startDm, onClose]);

  const handleClose = useCallback(() => {
    setQuery('');
    onClose();
  }, [onClose]);

  return (
    <Dialog open={open} onClose={handleClose} title="New Direct Message">
      <div className={styles.content}>
        <SearchInput
          placeholder="Search members..."
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

              return (
                <button
                  key={member.user_id}
                  type="button"
                  className={styles.memberItem}
                  onClick={() => handleStart(member.user_id)}
                  disabled={isCreating}
                >
                  <Avatar src={profile.avatar_url ?? undefined} name={name} size="sm" />
                  <div className={styles.memberInfo}>
                    <span className={styles.memberName}>{name}</span>
                    <span className={styles.memberEmail}>{profile.email}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </Dialog>
  );
}
