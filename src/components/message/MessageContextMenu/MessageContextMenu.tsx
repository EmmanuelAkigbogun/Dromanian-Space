import { useState, useEffect, useCallback, useRef, memo } from 'react';
import {
  ContextMenuProvider,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/ContextMenu';
import { useChannelSafe } from '@/hooks/useChannel';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/Toast';
import { useThreadSafe } from '@/app/providers/ThreadProvider';
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
import styles from './MessageContextMenu.module.css';

interface MessageContextMenuProps {
  message: Message;
  isOwn: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}

export const MessageContextMenu = memo(function MessageContextMenu({
  message,
  isOwn,
  canDelete,
  onEdit,
  onDelete,
  children,
}: MessageContextMenuProps) {
  const { currentChannel } = useChannelSafe();
  const { userId } = useAuth();
  const { toast } = useToast();
  const { openThread } = useThreadSafe() ?? { openThread: () => {} };
  const [isPinned, setIsPinned] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [isLoadingPin, setIsLoadingPin] = useState(false);
  const [isLoadingSave, setIsLoadingSave] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const { share } = useShareHandler();

  const channelId = message.channel_id ?? currentChannel?.id;
  const loadedRef = useRef(false);

  useEffect(() => {
    loadedRef.current = false;
    setIsPinned(false);
    setIsSaved(false);
  }, [message.id]);

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!open || loadedRef.current) return;
      if (!channelId || !userId || isTempId(message.id)) return;
      loadedRef.current = true;
      isMessagePinned(channelId, message.id).then(setIsPinned);
      isMessageSaved(userId, message.id).then(setIsSaved);
    },
    [channelId, userId, message.id],
  );

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content).then(() => {
      toast({ description: 'Message copied to clipboard', variant: 'success' });
    });
  }, [message.content, toast]);

  const handleCopyLink = useCallback(() => {
    navigator.clipboard.writeText(getMessagePermalink(message.id)).then(() => {
      toast({ description: 'Link copied to clipboard', variant: 'success' });
    });
  }, [message.id, toast]);

  const handleShare = useCallback(() => {
    const url = getMessagePermalink(message.id);
    share(
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
    setForwardOpen(true);
  }, []);

  const handlePin = useCallback(async () => {
    if (!channelId || !userId || isLoadingPin) return;
    setIsLoadingPin(true);
    try {
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
    } finally {
      setIsLoadingPin(false);
    }
  }, [channelId, userId, message.id, isPinned, isLoadingPin, toast]);

  const handleSave = useCallback(async () => {
    if (!userId || isLoadingSave) return;
    setIsLoadingSave(true);
    try {
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
    } finally {
      setIsLoadingSave(false);
    }
  }, [userId, message.id, isSaved, isLoadingSave, toast]);

  const handleReact = useCallback(async () => {
    if (!userId) return;
    await addReaction(message.id, userId, '👍');
    toast({ description: 'Reaction added', variant: 'success' });
  }, [message.id, userId, toast]);

  return (
    <ContextMenuProvider onOpenChange={handleMenuOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <div className={styles.contextMenu}>
          <ContextMenuItem onClick={handleCopy}>
            <span className={styles.itemIcon}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            </span>
            <span className={styles.itemLabel}>Copy message</span>
          </ContextMenuItem>

          <ContextMenuItem onClick={handleCopyLink}>
            <span className={styles.itemIcon}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
              </svg>
            </span>
            <span className={styles.itemLabel}>Copy link</span>
          </ContextMenuItem>

          <ContextMenuItem onClick={handleShare}>
            <span className={styles.itemIcon}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
                <polyline points="16 6 12 2 8 6" />
                <line x1="12" y1="2" x2="12" y2="15" />
              </svg>
            </span>
            <span className={styles.itemLabel}>Share</span>
          </ContextMenuItem>

          <ContextMenuItem onClick={handleForward}>
            <span className={styles.itemIcon}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            </span>
            <span className={styles.itemLabel}>Forward</span>
          </ContextMenuItem>

          <ContextMenuItem onClick={() => openThread(message)}>
            <span className={styles.itemIcon}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
            </span>
            <span className={styles.itemLabel}>Reply in thread</span>
          </ContextMenuItem>

          <ContextMenuItem onClick={handleReact}>
            <span className={styles.itemIcon}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                <line x1="9" y1="9" x2="9.01" y2="9" />
                <line x1="15" y1="9" x2="15.01" y2="9" />
              </svg>
            </span>
            <span className={styles.itemLabel}>Add reaction</span>
          </ContextMenuItem>

          <ContextMenuSeparator />

          {isOwn && (
            <ContextMenuItem onClick={onEdit}>
              <span className={styles.itemIcon}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </span>
              <span className={styles.itemLabel}>Edit message</span>
              <span className={styles.itemShortcut}>E</span>
            </ContextMenuItem>
          )}

          {canDelete && (
            <ContextMenuItem onClick={onDelete}>
              <span className={`${styles.itemIcon} ${styles.itemDanger}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
              </span>
              <span className={styles.itemLabel}>Delete message</span>
              <span className={styles.itemShortcut}>⌫</span>
            </ContextMenuItem>
          )}

          <ContextMenuSeparator />

          <ContextMenuItem onClick={handlePin} disabled={isLoadingPin}>
            <span className={styles.itemIcon}>
              {isPinned ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z" />
                </svg>
              )}
            </span>
            <span className={styles.itemLabel}>{isPinned ? 'Unpin message' : 'Pin message'}</span>
          </ContextMenuItem>

          <ContextMenuItem onClick={handleSave} disabled={isLoadingSave}>
            <span className={`${styles.itemIcon} ${isSaved ? styles.savedIndicator : ''}`}>
              {isSaved ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
                </svg>
              )}
            </span>
            <span className={styles.itemLabel}>{isSaved ? 'Unsave message' : 'Save message'}</span>
          </ContextMenuItem>
        </div>
      </ContextMenuContent>
      <ShareMessageDialog
        open={forwardOpen}
        onClose={() => setForwardOpen(false)}
        message={message}
        excludeChannelId={channelId}
      />
    </ContextMenuProvider>
  );
});