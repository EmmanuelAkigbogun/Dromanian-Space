import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useChannelSafe } from '@/hooks/useChannel';
import { useAuth } from '@/hooks/useAuth';
import { useThreadSafe } from '@/app/providers/ThreadProvider';
import { useMessageSelectionSafe } from '@/app/providers/MessageSelectionProvider';
import { useToast } from '@/components/ui/Toast';
import { EmojiPicker } from '@/components/ui/EmojiPicker';
import { useShareHandler } from '@/hooks/useShareHandler';
import { ShareMessageDialog } from '@/components/message/ShareMessageDialog';
import { addReaction, getMessagePermalink, isTempId } from '@/lib/message';
import {
  isMessagePinned,
  isMessageSaved,
  pinMessage as pinMessageService,
  unpinMessage as unpinMessageService,
  saveMessage as saveMessageService,
  unsaveMessage as unsaveMessageService,
} from '@/lib/message';
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
}

export const MessageActions = memo(function MessageActions({
  message,
  isOwn,
  canDelete,
  canPin,
  onEdit,
  onDelete,
  onReact,
}: MessageActionsProps) {
  const { currentChannel } = useChannelSafe();
  const { userId } = useAuth();
  const { openThread } = useThreadSafe() ?? { openThread: () => {} };
  const { toast } = useToast();
  const [isPinned, setIsPinned] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [pickerPosition, setPickerPosition] = useState<{ x: number; y: number } | undefined>();
  const [shareOpen, setShareOpen] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [shareMenuPosition, setShareMenuPosition] = useState<{ x: number; y: number } | undefined>();
  const shareMenuRef = useRef<HTMLDivElement>(null);
  const { share } = useShareHandler();
  const selection = useMessageSelectionSafe();
  const isSelected = selection?.isSelected(message.id) ?? false;

  const channelId = message.channel_id ?? currentChannel?.id;

  const loadStatus = useCallback(async () => {
    if (!channelId || !userId || loaded || isTempId(message.id)) return;
    const [pinStatus, saveStatus] = await Promise.all([
      isMessagePinned(channelId, message.id),
      isMessageSaved(userId, message.id),
    ]);
    setIsPinned(pinStatus);
    setIsSaved(saveStatus);
    setLoaded(true);
  }, [channelId, userId, message.id, loaded]);

  const handleMouseEnter = useCallback(() => {
    loadStatus();
  }, [loadStatus]);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(message.content);
    toast({ description: 'Message copied to clipboard', variant: 'success' });
  }, [message.content, toast]);

  const handleCopyLink = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(getMessagePermalink(message.id));
    toast({ description: 'Link copied to clipboard', variant: 'success' });
  }, [message.id, toast]);

  const handlePin = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!channelId || !userId) return;
    if (isPinned) {
      const success = await unpinMessageService(channelId, message.id);
      if (success) {
        setIsPinned(false);
        toast({ description: 'Message unpinned', variant: 'success' });
      } else {
        toast({ description: 'Failed to unpin message', variant: 'error' });
      }
    } else {
      const result = await pinMessageService(channelId, message.id, userId);
      if (result) {
        setIsPinned(true);
        toast({ description: 'Message pinned', variant: 'success' });
      } else {
        toast({ description: 'Failed to pin message', variant: 'error' });
      }
    }
  }, [channelId, userId, message.id, isPinned, toast]);

  const handleSave = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!userId) return;
    if (isSaved) {
      const success = await unsaveMessageService(userId, message.id);
      if (success) {
        setIsSaved(false);
        toast({ description: 'Message removed from saved', variant: 'success' });
      } else {
        toast({ description: 'Failed to remove saved message', variant: 'error' });
      }
    } else {
      const result = await saveMessageService(userId, message.id);
      if (result) {
        setIsSaved(true);
        toast({ description: 'Message saved', variant: 'success' });
      } else {
        toast({ description: 'Failed to save message', variant: 'error' });
      }
    }
  }, [userId, message.id, isSaved, toast]);

  const handleEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit();
  }, [onEdit]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  }, [onDelete]);

  const handleReplyInThread = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    openThread(message);
  }, [message, openThread]);

  const handleSelect = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    selection?.toggleSelected(message);
  }, [selection, message]);

  const handleShare = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (shareMenuOpen) {
      setShareMenuOpen(false);
    } else {
      setShareMenuPosition({ x: e.clientX, y: e.clientY });
      setShareMenuOpen(true);
    }
  }, [shareMenuOpen]);

  const handleShareNative = useCallback(async () => {
    setShareMenuOpen(false);
    const url = getMessagePermalink(message.id);
    await share(
      {
        title: 'Message',
        text: message.content,
        url,
      },
      () => {
        navigator.clipboard.writeText(url).then(() => {
          toast({ description: 'Link copied to clipboard', variant: 'success' });
        });
      },
    );
  }, [message.id, message.content, share, toast]);

  const handleForward = useCallback(() => {
    setShareMenuOpen(false);
    setShareOpen(true);
  }, []);

  useEffect(() => {
    if (!shareMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (shareMenuRef.current && !shareMenuRef.current.contains(e.target as Node)) {
        setShareMenuOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [shareMenuOpen]);

  const handleReact = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (showEmojiPicker) {
      setShowEmojiPicker(false);
    } else {
      setPickerPosition({ x: e.clientX, y: e.clientY });
      setShowEmojiPicker(true);
    }
  }, [showEmojiPicker]);

  const handleEmojiSelect = useCallback(async (emoji: string) => {
    setShowEmojiPicker(false);
    if (!userId) return;
    if (onReact) {
      onReact(emoji);
    } else {
      await addReaction(message.id, userId, emoji);
    }
  }, [message.id, userId, onReact]);

  return (
    <>
    <div
      className={`${styles.actions} ${isOwn ? styles.actionsOwn : ''}`}
      onMouseEnter={handleMouseEnter}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={styles.actionButton}
        onClick={handleReact}
        title="Add reaction"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 14s1.5 2 4 2 4-2 4-2" />
          <line x1="9" y1="9" x2="9.01" y2="9" />
          <line x1="15" y1="9" x2="15.01" y2="9" />
        </svg>
      </button>

      <button
        type="button"
        className={styles.actionButton}
        onClick={handleCopy}
        title="Copy message"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      </button>

      <button
        type="button"
        className={styles.actionButton}
        onClick={handleCopyLink}
        title="Copy link"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
        </svg>
      </button>

      <button
        type="button"
        className={styles.actionButton}
        onClick={handleShare}
        title="Share message"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="4" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="12" cy="4" r="2" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6.5 9.5L9.5 11M6.5 6.5L9.5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>

      {canPin && (
        <button
          type="button"
          className={`${styles.actionButton} ${isPinned ? styles.actionActive : ''}`}
          onClick={handlePin}
          title={isPinned ? 'Unpin message' : 'Pin message'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z" />
          </svg>
        </button>
      )}

      <button
        type="button"
        className={`${styles.actionButton} ${isSaved ? styles.actionActive : ''}`}
        onClick={handleSave}
        title={isSaved ? 'Unsave message' : 'Save message'}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill={isSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
          <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
        </svg>
      </button>

      <button
        type="button"
        className={styles.actionButton}
        onClick={handleReplyInThread}
        title="Reply in thread"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      </button>

      {selection && (
        <button
          type="button"
          className={`${styles.actionButton} ${isSelected ? styles.actionSelectActive : ''}`}
          onClick={handleSelect}
          title={isSelected ? 'Remove from selection' : 'Select message'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="9 12 11 14 15 10" />
          </svg>
        </button>
      )}

      {isOwn && (
        <button
          type="button"
          className={styles.actionButton}
          onClick={handleEdit}
          title="Edit message"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      )}

      {canDelete && (
        <button
          type="button"
          className={`${styles.actionButton} ${styles.actionDanger}`}
          onClick={handleDelete}
          title="Delete message"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
        </button>
      )}
    </div>
    {showEmojiPicker && (
      <EmojiPicker
        onSelect={handleEmojiSelect}
        onClose={() => setShowEmojiPicker(false)}
        position={pickerPosition}
      />
    )}
    {shareMenuOpen && shareMenuPosition && (
      <div
        ref={shareMenuRef}
        className={styles.shareMenu}
        style={{ position: 'fixed', top: shareMenuPosition.y, left: shareMenuPosition.x, transform: 'translateY(4px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className={styles.shareMenuItem} onClick={handleShareNative}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
            <polyline points="16 6 12 2 8 6" />
            <line x1="12" y1="2" x2="12" y2="15" />
          </svg>
          <span>Share</span>
        </button>
        <button type="button" className={styles.shareMenuItem} onClick={handleForward}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
          <span>Forward</span>
        </button>
      </div>
    )}
    <ShareMessageDialog
      open={shareOpen}
      onClose={() => setShareOpen(false)}
      message={message}
      excludeChannelId={channelId}
    />
  </>
  );
});
