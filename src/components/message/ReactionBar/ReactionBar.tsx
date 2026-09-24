import { useState, useRef, useCallback, memo } from 'react';
import { EmojiPicker } from '@/components/ui/EmojiPicker';
import { ReactionsPopover } from '@/components/message/ReactionsPopover';
import type { ReactionGroup } from '@/lib/message';
import styles from './ReactionBar.module.css';

interface ReactionBarProps {
  reactions: ReactionGroup[];
  onReact: (emoji: string) => void;
  onRemoveReaction: (emoji: string) => void;
}

export const ReactionBar = memo(function ReactionBar({
  reactions,
  onReact,
  onRemoveReaction,
}: ReactionBarProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [popoverAnchor, setPopoverAnchor] = useState<HTMLElement | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  const handlePillClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setPopoverAnchor(e.currentTarget);
  }, []);

  const handlePopoverSelect = useCallback((emoji: string) => {
    const existingOwn = reactions.find((r) => r.hasOwn);
    if (existingOwn && existingOwn.emoji === emoji) {
      onRemoveReaction(emoji);
    } else {
      if (existingOwn) {
        onRemoveReaction(existingOwn.emoji);
      }
      onReact(emoji);
    }
    setPopoverAnchor(null);
  }, [reactions, onReact, onRemoveReaction]);

  const handlePickerSelect = useCallback((emoji: string) => {
    const existingOwn = reactions.find((r) => r.hasOwn);
    if (existingOwn && existingOwn.emoji === emoji) {
      onRemoveReaction(emoji);
    } else {
      if (existingOwn) {
        onRemoveReaction(existingOwn.emoji);
      }
      onReact(emoji);
    }
    setShowPicker(false);
  }, [reactions, onReact, onRemoveReaction]);

  if (reactions.length === 0) {
    return (
      <div className={styles.container}>
        <button
          ref={addRef}
          type="button"
          className={styles.addButton}
          onClick={() => setShowPicker(!showPicker)}
          title="Add reaction"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
            <line x1="9" y1="9" x2="9.01" y2="9" />
            <line x1="15" y1="9" x2="15.01" y2="9" />
          </svg>
        </button>
        {showPicker && (
          <EmojiPicker
            onSelect={handlePickerSelect}
            onClose={() => setShowPicker(false)}
            anchorRef={addRef}
          />
        )}
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {reactions.map((group) => (
        <button
          key={group.emoji}
          type="button"
          className={`${styles.reaction} ${group.hasOwn ? styles.reactionActive : ''}`}
          onClick={handlePillClick}
          title={`${group.emoji} ${group.count}`}
        >
          <span className={styles.emoji}>{group.emoji}</span>
          <span className={styles.count}>{group.count}</span>
        </button>
      ))}
      <button
        ref={addRef}
        type="button"
        className={styles.addButton}
        onClick={() => setShowPicker(!showPicker)}
        title="Add reaction"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="16" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
      </button>
      {showPicker && (
        <EmojiPicker
          onSelect={handlePickerSelect}
          onClose={() => setShowPicker(false)}
          anchorRef={addRef}
        />
      )}
      {popoverAnchor && (
        <ReactionsPopover
          groups={reactions}
          anchorRef={{ current: popoverAnchor }}
          onSelect={handlePopoverSelect}
          onClose={() => setPopoverAnchor(null)}
        />
      )}
    </div>
  );
});
