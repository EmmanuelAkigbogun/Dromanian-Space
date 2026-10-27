import { memo, useEffect, useMemo } from 'react';
import { useProfiles } from '@/hooks/useProfiles';
import { useAuth } from '@/hooks/useAuth';
import { getDisplayName } from '@/lib/message/formatting';
import type { ReactionGroup } from '@/lib/message/reaction';
import { Portal } from '@/lib/overlay/Portal';
import { useFocusTrap } from '@/lib/overlay/useFocusTrap';
import { useOverlayStack } from '@/lib/overlay/useOverlayStack';
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
  const containerRef = useFocusTrap(Boolean(group));
  useOverlayStack(Boolean(group));

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  if (!group) return null;

  return (
    <Portal>
    <div ref={containerRef} className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true" aria-label="Reactions" tabIndex={-1}>
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
    </Portal>
  );
});
