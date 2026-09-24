import { useState, useEffect, useCallback, memo } from 'react';
import { useMessageSafe } from '@/hooks/useMessage';
import { useEditSafe } from '@/app/providers/EditProvider';
import { useAuth } from '@/hooks/useAuth';
import { useThreadSafe } from '@/app/providers/ThreadProvider';
import { useThreadCountsSafe } from '@/app/providers/ThreadProvider';
import { useMessageSelectionSafe } from '@/app/providers/MessageSelectionProvider';
import { hasPermission } from '@/lib/workspace/permissions';
import {
  formatTime,
  formatRelativeTime,
  getDisplayName,
  isTempId,
  addReaction,
  getMessageReactions,
  invalidateMessageReactions,
  groupReactions,
} from '@/lib/message';
import { useMessageAttachments, useInvalidateAttachments } from '@/hooks/useMessageAttachments';
import { MessageContent } from '@/components/message/MessageContent';
import { AttachmentGrid } from '@/components/message/AttachmentPreview/AttachmentGrid';
import { Avatar } from '@/components/ui/Avatar';
import { UserProfilePopover } from '@/components/ui/UserProfilePopover';
import { MessageContextMenu } from '@/components/message/MessageContextMenu';
import { MessageActions } from '@/components/message/MessageActions';
import { DeleteConfirmDialog } from '@/components/message/DeleteConfirmDialog';
import { ReactionsPopover } from '@/components/message/ReactionsPopover';
import { RemoveEmbedConfirmDialog } from '@/components/message/RemoveEmbedConfirmDialog';
import { LinkPreviewCard } from '@/components/message/LinkPreview';
import { extractUrls, removeUrlsFromText } from '@/lib/message/richText';
import type { LinkDisplayMode, Message, Profile, Reaction } from '@/types';
import styles from './MessageItem.module.css';

interface MessageItemProps {
  message: Message;
  isOwn: boolean;
  profile: Profile | null;
  isGrouped: boolean;
  onDeleteMessage?: (messageId: string) => Promise<void>;
  onRemoveLink?: (messageId: string, url: string) => Promise<void>;
  onStartEdit?: (message: Message) => void;
  highlight?: boolean;
  compact?: boolean;
}

export const MessageItem = memo(function MessageItem({ message, isOwn, profile, isGrouped, onDeleteMessage, onRemoveLink, onStartEdit, highlight, compact }: MessageItemProps) {
  const { updateMessage: ctxUpdateMessage, deleteMessage: ctxDeleteMessage } = useMessageSafe();
  const editCtx = useEditSafe();
  const { userId, userRole } = useAuth();
  const threadCtx = useThreadSafe();
  const threadCountsCtx = useThreadCountsSafe();
  const selection = useMessageSelectionSafe();
  const isSelected = selection?.isSelected(message.id) ?? false;
  const selectionMode = (selection?.selectedCount ?? 0) > 0;
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [pendingRemoveUrl, setPendingRemoveUrl] = useState<string | null>(null);
  const [isRemovingLink, setIsRemovingLink] = useState(false);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const { attachments } = useMessageAttachments(message.id);
  const invalidateAttachments = useInvalidateAttachments();
  const [isHovered, setIsHovered] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [popoverAnchor, setPopoverAnchor] = useState<HTMLElement | null>(null);

  const isDeleted = !!message.deleted_at;
  const isEdited = !!message.edited_at;
  const displayName = getDisplayName(profile, message.user_id);
  const replyCount = threadCountsCtx?.replyCounts.get(message.id) ?? 0;

  const canDelete = isOwn || hasPermission(userRole as 'owner' | 'admin' | 'member' | null, 'message:delete_any');
  const canPin = !!userId;

  useEffect(() => {
    if (isTempId(message.id)) return;
    getMessageReactions(message.id).then(setReactions);
  }, [message.id]);

  useEffect(() => {
    function handleAttachmentsUpdated(e: Event) {
      const { messageId } = (e as CustomEvent).detail;
      if (messageId === message.id) {
        invalidateAttachments(message.id);
      }
    }
    window.addEventListener('attachments-updated', handleAttachmentsUpdated);
    return () => window.removeEventListener('attachments-updated', handleAttachmentsUpdated);
  }, [message.id, invalidateAttachments]);

  useEffect(() => {
    function handleReactionsUpdated(e: Event) {
      const { messageId } = (e as CustomEvent).detail;
      if (messageId === message.id) {
        invalidateMessageReactions(message.id);
        getMessageReactions(message.id).then(setReactions);
      }
    }
    window.addEventListener('reactions-updated', handleReactionsUpdated);
    return () => window.removeEventListener('reactions-updated', handleReactionsUpdated);
  }, [message.id]);

  const reactionGroups = groupReactions(reactions, userId ?? '');

  const handleReact = useCallback(async (emoji: string) => {
    if (!userId) return;
    setReactions((prev) => {
      const existing = prev.find((r) => r.emoji === emoji && r.user_id === userId);
      if (existing) {
        return prev.filter((r) => r.id !== existing.id);
      }
      return [...prev, { id: `temp-${Date.now()}`, message_id: message.id, user_id: userId, emoji, created_at: new Date().toISOString() }];
    });
    addReaction(message.id, userId, emoji).then(() => {
      getMessageReactions(message.id).then(setReactions);
    });
  }, [message.id, userId]);

  const handlePopoverSelect = useCallback(async (emoji: string) => {
    if (!userId) return;
    setReactions((prev) => {
      const existing = prev.find((r) => r.emoji === emoji && r.user_id === userId);
      if (existing) {
        return prev.filter((r) => r.id !== existing.id);
      }
      return [...prev, { id: `temp-${Date.now()}`, message_id: message.id, user_id: userId, emoji, created_at: new Date().toISOString() }];
    });
    setPopoverAnchor(null);
    addReaction(message.id, userId, emoji).then(() => {
      getMessageReactions(message.id).then(setReactions);
    });
  }, [message.id, userId]);

  const handlePillClick = useCallback((e: React.MouseEvent<HTMLButtonElement>, group: { emoji: string; hasOwn: boolean }) => {
    if (reactionGroups.length > 3) {
      setPopoverAnchor(e.currentTarget);
    } else {
      handleReact(group.emoji);
    }
  }, [reactionGroups.length, handleReact]);

  const visibleReactions = reactionGroups.slice(0, 3);

  const handleStartEdit = useCallback(() => {
    if (onStartEdit) {
      onStartEdit(message);
    } else {
      editCtx?.startEditing(message);
    }
  }, [message, editCtx, onStartEdit]);

  const handleRequestDelete = useCallback(() => {
    setShowDeleteDialog(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      const doDelete = onDeleteMessage ?? ctxDeleteMessage;
      await doDelete(message.id);
      selection?.removeSelected(message.id);
      setShowDeleteDialog(false);
    } finally {
      setIsDeleting(false);
    }
  }, [message.id, ctxDeleteMessage, onDeleteMessage, selection]);

  const handleCancelDelete = useCallback(() => {
    if (!isDeleting) {
      setShowDeleteDialog(false);
    }
  }, [isDeleting]);

  const handleRemoveLink = useCallback((url: string) => {
    setPendingRemoveUrl(url);
  }, []);

  const handleConfirmRemoveLink = useCallback(async () => {
    if (!pendingRemoveUrl) return;
    setIsRemovingLink(true);
    try {
      const newContent = removeUrlsFromText(message.content, [pendingRemoveUrl]).trim();
      if (!newContent) {
        const doDelete = onDeleteMessage ?? ctxDeleteMessage;
        await doDelete(message.id);
        selection?.removeSelected(message.id);
      } else {
        const remainingUrls = extractUrls(newContent);
        const newLinkMode: LinkDisplayMode | null = remainingUrls.length > 0 ? 'embed' : 'text';
        if (onRemoveLink) {
          await onRemoveLink(message.id, pendingRemoveUrl);
        } else {
          await ctxUpdateMessage(message.id, newContent, newLinkMode);
        }
      }
      setPendingRemoveUrl(null);
    } finally {
      setIsRemovingLink(false);
    }
  }, [pendingRemoveUrl, message.id, message.content, ctxUpdateMessage, ctxDeleteMessage, onDeleteMessage, onRemoveLink, selection]);

  const handleCancelRemoveLink = useCallback(() => {
    if (!isRemovingLink) {
      setPendingRemoveUrl(null);
    }
  }, [isRemovingLink]);

  const handleOpenThread = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    threadCtx?.openThread(message);
  }, [message, threadCtx]);

  const handleRowClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, [data-no-select]')) return;
    if (selectionMode && selection) {
      selection.toggleSelected(message);
      return;
    }
    setShowActions((s) => !s);
  }, [selectionMode, selection, message]);

  if (isDeleted) {
    return (
      <div className={`${styles.message} ${styles.messageDeleted}`}>
        <div className={styles.deleted}>This message was deleted</div>
      </div>
    );
  }

  return (
    <>
      <MessageContextMenu
        message={message}
        isOwn={isOwn}
        canDelete={canDelete}
        onEdit={handleStartEdit}
        onDelete={handleRequestDelete}
      >
        <div
          className={`${styles.row} ${selectionMode ? styles.rowSelectable : ''}`}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <div
            id={`message-${message.id}`}
            className={`${styles.message} ${isOwn ? styles.messageOwn : ''} ${isGrouped ? styles.messageGrouped : ''} ${highlight ? 'message-highlight' : ''} ${isSelected ? styles.messageSelected : ''}`}
            onClick={handleRowClick}
          >
              <div className={styles.content}>
                <div className={styles.header}>
                  <div className={styles.avatar}>
                    {isGrouped ? (
                      <span className={styles.timestampInline}>{formatTime(message.created_at)}</span>
                    ) : (
                      <UserProfilePopover userId={message.user_id} side="right">
                        <Avatar
                          src={profile?.avatar_url || undefined}
                          name={displayName}
                          size="sm"
                        />
                      </UserProfilePopover>
                    )}
                  </div>
                  {!isGrouped && (
                    <>
                      <span className={styles.username}>{displayName}</span>
                      <span className={styles.time} title={new Date(message.created_at).toLocaleString()}>
                        {formatRelativeTime(message.created_at)}
                      </span>
                      {isEdited && <span className={styles.edited}>(edited)</span>}
                    </>
                  )}
                </div>

              {message.forwarded_from_message_id && (
                <span className={styles.forwardedLabel} title="Forwarded from another message">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                  </svg>
                  Forwarded
                </span>
              )}

              {(() => {
                const urls = extractUrls(message.content);
                const linkMode = message.link_mode ?? 'embed';
                const showLinkPreviews = linkMode === 'embed' && urls.length > 0;
                const displayContent = showLinkPreviews ? removeUrlsFromText(message.content, urls) : message.content;
                return (
                  <>
                    {displayContent.trim() && (
                      <div className={styles.text}>
                        <MessageContent content={displayContent} />
                      </div>
                    )}
                    {showLinkPreviews && (
                      <div className={styles.linkPreviews}>
                        {urls.map((url) => (
                          <LinkPreviewCard key={url} url={url} onDelete={isOwn ? handleRemoveLink : undefined} />
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}

              {attachments.length > 0 && (
                  <div className={`${styles.attachments} ${attachments.length === 1 ? styles.attachmentsSingle : ''}`}>
                    <AttachmentGrid
                      attachments={attachments}
                      messageId={message.id}
                      creatorId={message.user_id}
                      defaultLayout={message.attachments_layout}
                      viewerId={userId}
                      onAttachmentsChanged={() => invalidateAttachments(message.id)}
                      compact={compact}
                    />
                  </div>
              )}

              {reactionGroups.length > 0 && (
                <div className={styles.reactions}>
                  {visibleReactions.map((group) => (
                    <button
                      key={group.emoji}
                      type="button"
                      className={`${styles.reactionPill} ${group.hasOwn ? styles.reactionPillActive : ''}`}
                      onClick={(e) => handlePillClick(e, group)}
                      title={`${group.emoji} ${group.count}`}
                    >
                      <span className={styles.reactionEmoji}>{group.emoji}</span>
                      <span className={styles.reactionCount}>{group.count}</span>
                    </button>
                  ))}
                  {reactionGroups.length > 3 && (
                    <button
                      type="button"
                      className={styles.reactionPill}
                      onClick={(e) => setPopoverAnchor(e.currentTarget)}
                      title="View all reactions"
                    >
                      <span className={styles.reactionCount}>+{reactionGroups.length - 3}</span>
                    </button>
                  )}
                </div>
              )}

              {popoverAnchor && (
                <ReactionsPopover
                  groups={reactionGroups}
                  anchorRef={{ current: popoverAnchor }}
                  onSelect={handlePopoverSelect}
                  onClose={() => setPopoverAnchor(null)}
                />
              )}

              {replyCount > 0 && (
                <button
                  type="button"
                  className={styles.threadLink}
                  onClick={handleOpenThread}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                  </svg>
                  {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                </button>
              )}
            </div>
          </div>

          <div
            data-no-select
            className={`${styles.actionsBar} ${isHovered || isSelected || showActions ? styles.actionsBarVisible : ''}`}
          >
            <MessageActions
              message={message}
              isOwn={isOwn}
              canDelete={canDelete}
              canPin={canPin}
              onEdit={handleStartEdit}
              onDelete={handleRequestDelete}
              onReact={handleReact}
            />
          </div>
        </div>
      </MessageContextMenu>

      <DeleteConfirmDialog
        open={showDeleteDialog}
        onClose={handleCancelDelete}
        onConfirm={handleConfirmDelete}
        message={message}
        profile={profile}
        isDeleting={isDeleting}
      />

      <RemoveEmbedConfirmDialog
        open={!!pendingRemoveUrl}
        onClose={handleCancelRemoveLink}
        onConfirm={handleConfirmRemoveLink}
        url={pendingRemoveUrl ?? ''}
        isRemoving={isRemovingLink}
      />
    </>
  );
});
