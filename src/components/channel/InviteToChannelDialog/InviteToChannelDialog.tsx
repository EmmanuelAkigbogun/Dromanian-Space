import { useState, useEffect, useCallback } from 'react';
import { useChannel } from '@/hooks/useChannel';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/Toast';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import {
  inviteToChannel,
  getChannelMemberIds,
  getChannelMembers,
  getWorkspaceMembersWithProfiles,
  getUserChannelRole,
  removeChannelMember,
} from '@/lib/channel';
import type { Channel, ChannelMember, ChannelRole, Profile } from '@/types';
import type { WorkspaceMemberWithProfile } from '@/lib/channel/channel';
import styles from './InviteToChannelDialog.module.css';

interface InviteToChannelDialogProps {
  open: boolean;
  onClose: () => void;
  channel: Channel;
}

interface CurrentMember {
  user_id: string;
  role: ChannelRole;
  profile: Profile | null;
}

export function InviteToChannelDialog({ open, onClose, channel }: InviteToChannelDialogProps) {
  const { currentWorkspace } = useWorkspace();
  const { userId } = useAuth();
  const { toast } = useToast();
  const { refreshChannels } = useChannel();
  const [members, setMembers] = useState<WorkspaceMemberWithProfile[]>([]);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [currentMembers, setCurrentMembers] = useState<CurrentMember[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [search, setSearch] = useState('');

  const loadData = useCallback(async () => {
    if (!currentWorkspace) return;
    const [workspaceMembers, channelMemberIds, channelMembers, myRole] = await Promise.all([
      getWorkspaceMembersWithProfiles(currentWorkspace.id),
      getChannelMemberIds(channel.id),
      getChannelMembers(channel.id),
      userId ? getUserChannelRole(channel.id, userId) : null,
    ]);

    setMembers(workspaceMembers);
    setMemberIds(new Set(channelMemberIds));
    setCanManage(myRole === 'owner' || myRole === 'admin');

    const profileByUserId = new Map(workspaceMembers.map((m) => [m.user_id, m.profile]));
    setCurrentMembers(
      (channelMembers as ChannelMember[]).map((cm) => ({
        user_id: cm.user_id,
        role: cm.role,
        profile: profileByUserId.get(cm.user_id) ?? null,
      })),
    );
  }, [currentWorkspace, channel.id, userId]);

  useEffect(() => {
    if (!open) return;

    setIsLoading(true);
    setSelectedIds(new Set());

    loadData().finally(() => setIsLoading(false));
  }, [open, loadData]);

  const filteredMembers = members.filter((m) => {
    if (memberIds.has(m.user_id)) return false;
    if (!search) return true;
    const name = m.profile?.display_name || m.profile?.username || m.profile?.email || '';
    return name.toLowerCase().includes(search.toLowerCase());
  });

  function toggleSelect(userId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }

  async function handleInvite() {
    if (!userId || selectedIds.size === 0) return;

    setIsSubmitting(true);
    let invited = 0;

    for (const memberId of selectedIds) {
      const result = await inviteToChannel(channel.id, memberId, userId);
      if (result) invited++;
    }

    if (invited > 0) {
      toast({ variant: 'success', description: `Invited ${invited} member${invited === 1 ? '' : 's'}` });
      await refreshChannels();
      await loadData();
    } else {
      toast({ variant: 'error', description: 'Failed to invite members' });
    }

    setIsSubmitting(false);
    onClose();
  }

  async function handleRemove(memberId: string) {
    if (!userId || isSubmitting) return;

    setIsSubmitting(true);
    const ok = await removeChannelMember(channel.id, memberId);

    if (ok) {
      toast({ variant: 'success', description: 'Member removed' });
      await refreshChannels();
      await loadData();
    } else {
      toast({ variant: 'error', description: 'Failed to remove member' });
    }

    setIsSubmitting(false);
  }

  function handleClose() {
    if (isSubmitting) return;
    setSearch('');
    setSelectedIds(new Set());
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Manage members"
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleInvite}
            loading={isSubmitting}
            disabled={selectedIds.size === 0}
          >
            Invite {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
          </Button>
        </div>
      }
    >
      <div className={styles.content}>
        <p className={styles.description}>
          Manage members of <strong>#{channel.name}</strong>
        </p>

        <div className={styles.sectionTitle}>
          Members ({currentMembers.length})
        </div>
        <div className={styles.memberList}>
          {currentMembers.length === 0 && !isLoading && (
            <div className={styles.empty}>No members</div>
          )}
          {currentMembers.map((member) => {
            const name = member.profile?.display_name || member.profile?.username || 'Unknown';
            const isSelf = member.user_id === userId;
            const canRemove = canManage && !isSelf && member.role !== 'owner';

            return (
              <div key={member.user_id} className={styles.currentMemberItem}>
                <Avatar
                  src={member.profile?.avatar_url || undefined}
                  name={name}
                  size="sm"
                />
                <div className={styles.memberInfo}>
                  <span className={styles.memberName}>
                    {name}
                    {isSelf && <span className={styles.selfBadge}>you</span>}
                  </span>
                  {member.profile?.username && member.profile.display_name && (
                    <span className={styles.memberUsername}>@{member.profile.username}</span>
                  )}
                </div>
                {member.role !== 'member' && (
                  <span className={styles.roleBadge}>{member.role}</span>
                )}
                {canRemove && (
                  <button
                    type="button"
                    className={styles.removeButton}
                    onClick={() => handleRemove(member.user_id)}
                    disabled={isSubmitting}
                    title="Remove member"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18" />
                      <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
                    </svg>
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className={styles.sectionTitle}>Add members</div>
        <input
          type="text"
          className={styles.search}
          placeholder="Search members..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />

        {isLoading ? (
          <div className={styles.loading}>Loading members...</div>
        ) : filteredMembers.length === 0 ? (
          <div className={styles.empty}>
            {search ? 'No members found' : 'All workspace members are already in this channel'}
          </div>
        ) : (
          <div className={styles.memberList}>
            {filteredMembers.map((member) => {
              const name = member.profile?.display_name || member.profile?.username || 'Unknown';
              const isSelected = selectedIds.has(member.user_id);

              return (
                <button
                  key={member.user_id}
                  type="button"
                  className={`${styles.memberItem} ${isSelected ? styles.memberItemSelected : ''}`}
                  onClick={() => toggleSelect(member.user_id)}
                >
                  <Avatar
                    src={member.profile?.avatar_url || undefined}
                    name={name}
                    size="sm"
                  />
                  <div className={styles.memberInfo}>
                    <span className={styles.memberName}>{name}</span>
                    {member.profile?.username && member.profile.display_name && (
                      <span className={styles.memberUsername}>@{member.profile.username}</span>
                    )}
                  </div>
                  {isSelected && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={styles.checkIcon}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
