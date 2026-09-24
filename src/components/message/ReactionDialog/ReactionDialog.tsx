import { memo, useMemo } from 'react';
import { useProfiles } from '@/hooks/useProfiles';
import { useAuth } from '@/hooks/useAuth';
import { getDisplayName } from '@/lib/message/formatting';
import type { ReactionGroup } from '@/lib/message/reaction';
import styles from './ReactionDialog.module.css';

interface ReactionDialogProps {
  groups: ReactionGroup[];
  emoji: string;
  onClose: () => void;
}

export const ReactionDialog = memo(function ReactionDialog({
  groups,
  emoji,
  onClose,
}: ReactionDialogProps) {
  const { userId } = useAuth();
  const group = useMemo(() => groups.find((g) => g.emoji === emoji), [groups, emoji]);
  const { profiles } = useProfiles(group?.userIds ?? []);

  if (!group) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.popup} onClick={(e) => e.stopPropagation()}>
        <div className={styles.emojiHeader}>
          <span className={styles.emoji}>{group.emoji}</span>
          <span className={styles.count}>{group.count}</span>
        </div>
        <div className={styles.names}>
          {group.userIds.map((uid, i) => {
            const profile = profiles.get(uid) ?? null;
            const isOwn = uid === userId;
            const name = getDisplayName(profile, uid);
            return (
              <span key={uid} className={`${styles.name} ${isOwn ? styles.nameOwn : ''}`}>
                {name}{isOwn ? ' (you)' : ''}
                {i < group.userIds.length - 1 && <span className={styles.separator}>┃</span>}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
});
