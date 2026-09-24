import { useState, useEffect, useCallback } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Avatar } from '@/components/ui/Avatar';
import { Spinner } from '@/components/ui/Spinner';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/Toast';
import { getWorkspaceMembers, transferOwnership } from '@/lib/workspace';
import { getProfilesByUserIds } from '@/lib/profile';
import type { WorkspaceMember, Profile } from '@/types';
import styles from './TransferOwnershipDialog.module.css';

interface TransferOwnershipDialogProps {
  open: boolean;
  onClose: () => void;
}

interface MemberWithProfile extends WorkspaceMember {
  profile: Profile | null;
}

export function TransferOwnershipDialog({ open, onClose }: TransferOwnershipDialogProps) {
  const { currentWorkspace } = useWorkspace();
  const { userId } = useAuth();
  const { toast } = useToast();

  const [members, setMembers] = useState<MemberWithProfile[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [isTransferring, setIsTransferring] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!open || !currentWorkspace || !userId) return;

    setIsLoading(true);
    setSelectedUserId(null);
    getWorkspaceMembers(currentWorkspace.id)
      .then(async (all) => {
        const others = all.filter((m) => m.user_id !== userId);
        const userIds = others.map((m) => m.user_id);
        const profiles = await getProfilesByUserIds(userIds);
        const profileMap = new Map(profiles.map((p) => [p.id, p]));
        const withProfiles = others.map((member) => ({
          ...member,
          profile: profileMap.get(member.user_id) ?? null,
        }));
        setMembers(withProfiles);
      })
      .finally(() => setIsLoading(false));
  }, [open, currentWorkspace, userId]);

  const handleTransfer = useCallback(async () => {
    if (!currentWorkspace || !userId || !selectedUserId) return;

    setIsTransferring(true);
    try {
      const success = await transferOwnership(currentWorkspace.id, userId, selectedUserId);
      if (success) {
        toast({ variant: 'success', title: 'Ownership transferred', description: 'The transfer was successful.' });
        onClose();
      } else {
        toast({ variant: 'error', description: 'Failed to transfer ownership.' });
      }
    } catch {
      toast({ variant: 'error', description: 'An unexpected error occurred.' });
    } finally {
      setIsTransferring(false);
    }
  }, [currentWorkspace, userId, selectedUserId, toast, onClose]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Transfer ownership"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isTransferring}>
            Cancel
          </Button>
          <Button
            loading={isTransferring}
            disabled={!selectedUserId}
            onClick={handleTransfer}
          >
            Transfer ownership
          </Button>
        </>
      }
    >
      <div className={styles.content}>
        <Alert variant="warning">
          You will become an admin after transferring ownership. This action cannot be easily undone.
        </Alert>

        {isLoading ? (
          <div className={styles.loading}>
            <Spinner size="md" />
          </div>
        ) : members.length === 0 ? (
          <p className={styles.empty}>No other members to transfer to.</p>
        ) : (
          <div className={styles.memberList}>
            {members.map((member) => (
              <label
                key={member.user_id}
                className={`${styles.memberOption} ${selectedUserId === member.user_id ? styles.selected : ''}`}
              >
                <input
                  type="radio"
                  name="transfer-target"
                  value={member.user_id}
                  checked={selectedUserId === member.user_id}
                  onChange={() => setSelectedUserId(member.user_id)}
                  className={styles.radio}
                />
                <Avatar
                  src={member.profile?.avatar_url ?? undefined}
                  name={member.profile?.display_name || member.profile?.username || 'U'}
                  size="sm"
                />
                <div className={styles.memberInfo}>
                  <span className={styles.memberName}>
                    {member.profile?.display_name || member.profile?.username || 'Unknown'}
                  </span>
                  <span className={styles.memberEmail}>{member.profile?.email}</span>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
