// The hover bar on a message holds reactions only: five quick ones and a
// picker for the rest. Everything else (reply, copy, share, forward, thread,
// pin, save, select, edit, delete) lives in the right-click / long-press menu.
import { memo, useCallback, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { ReactionPicker } from '@/components/message/ReactionPicker';
import { addReaction } from '@/lib/message';
import type { Message } from '@/types';
import styles from './MessageActions.module.css';

interface MessageActionsProps {
  message: Message;
  isOwn: boolean;
  canDelete: boolean;
  canPin: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onReact?: (emoji: string) => void;
  /** Kept for callers; replies are in the message menu. */
  onReply?: () => void;
}

/** One tap reactions, like Teams and WhatsApp. */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏'];

export const MessageActions = memo(function MessageActions({ message, isOwn, onReact }: MessageActionsProps) {
  const { userId } = useAuth();
  const [showPicker, setShowPicker] = useState(false);
  const [pickerPosition, setPickerPosition] = useState<{ x: number; y: number } | undefined>();
  const pickerButton = useRef<HTMLButtonElement>(null);

  const react = useCallback(async (emoji: string) => {
    setShowPicker(false);
    if (!userId) return;
    if (onReact) onReact(emoji);
    else await addReaction(message.id, userId, emoji);
  }, [message.id, userId, onReact]);

  return (
    <>
      <div
        className={`${styles.actions} ${isOwn ? styles.actionsOwn : ''}`}
        role="group"
        aria-label="React to message"
        onClick={(e) => e.stopPropagation()}
      >
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={styles.quickReaction}
            onClick={() => void react(emoji)}
            title={`React ${emoji}`}
            aria-label={`React with ${emoji}`}
          >
            {emoji}
          </button>
        ))}
        <button
          ref={pickerButton}
          type="button"
          className={styles.morePicker}
          onClick={(e) => {
            e.stopPropagation();
            if (showPicker) { setShowPicker(false); return; }
            setPickerPosition({ x: e.clientX, y: e.clientY });
            setShowPicker(true);
          }}
          title="More reactions · right-click the message for other actions"
          aria-label="More reactions"
          aria-haspopup="dialog"
          aria-expanded={showPicker}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M8.5 14s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9 9.5h.01M15 9.5h.01" />
          </svg>
          <span aria-hidden="true">+</span>
        </button>
      </div>
      {showPicker && (
        <ReactionPicker
          onSelect={(emoji) => void react(emoji)}
          onClose={() => setShowPicker(false)}
          anchorRef={pickerButton}
          position={pickerPosition}
        />
      )}
    </>
  );
});
