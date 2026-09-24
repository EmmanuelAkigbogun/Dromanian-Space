import { useEffect, useCallback, useRef, memo } from 'react';
import { Portal } from '@/lib/overlay/Portal';
import type { ReactionGroup } from '@/lib/message/reaction';
import styles from './ReactionsPopover.module.css';

interface ReactionsPopoverProps {
  groups: ReactionGroup[];
  anchorRef: React.RefObject<HTMLElement | null>;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export const ReactionsPopover = memo(function ReactionsPopover({
  groups,
  anchorRef,
  onSelect,
  onClose,
}: ReactionsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  const handleSelect = useCallback((emoji: string) => {
    onSelect(emoji);
  }, [onSelect]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, anchorRef]);

  const popoverStyle = (() => {
    if (!anchorRef.current) return {};
    const rect = anchorRef.current.getBoundingClientRect();
    const margin = 8;
    const popoverWidth = 6 * 56 + 8;
    let x = rect.left;
    let y = rect.bottom + margin;
    if (x + popoverWidth + margin > window.innerWidth) {
      x = window.innerWidth - popoverWidth - margin;
    }
    if (y + 200 > window.innerHeight) {
      y = rect.top - margin;
    }
    if (x < margin) x = margin;
    if (y < margin) y = margin;
    return { left: x, top: y };
  })();

  return (
    <Portal>
      <div ref={popoverRef} className={styles.popover} style={popoverStyle}>
        <div className={styles.grid}>
          {groups.map((group) => (
            <button
              key={group.emoji}
              type="button"
              className={`${styles.chip} ${group.hasOwn ? styles.chipSelected : ''}`}
              onClick={() => handleSelect(group.emoji)}
              title={`${group.emoji} ${group.count}`}
            >
              <span className={styles.emoji}>{group.emoji}</span>
              <span className={styles.count}>{group.count}</span>
              {group.hasOwn && (
                <span className={styles.checkmark}>✓</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </Portal>
  );
});
