import { useState, useEffect, useCallback, memo } from 'react';
import { useMessageSafe } from '@/hooks/useMessage';
import { useEditSafe } from '@/app/providers/EditProvider';
import { useAuth } from '@/hooks/useAuth';
import { useThreadSafe, useThreadCountsSafe } from '@/app/providers/ThreadProvider';
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
import styles from './ThreadReplyItem.module.css';

interface ThreadReplyItemProps {
  reply: Message;
  isOwn: boolean;
  profile: Profile | null;
  isGrouped: boolean;
}

export const ThreadReplyItem = memo(function ThreadReplyItem({ reply, isOwn, profile, isGrouped }: ThreadReplyItemProps) {
  const { deleteMessage, updateMessage } = useMessageSafe();
  const editCtx = useEditSafe();
  const { userId, userRole } = useAuth();
  const threadCtx = useThreadSafe();
  const threadCountsCtx = useThreadCountsSafe();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [pendingRemoveUrl, setPendingRemoveUrl] = useState<string | null>(null);
  const [isRemovingLink, setIsRemovingLink] = useState(false);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const { attachments } = useMessageAttachments(reply.id);
  const invalidateAttachments = useInvalidateAttachments();
  const [isHovered, setIsHovered] = useState(false);
  const [popoverAnchor, setPopoverAnchor] = useState<HTMLElement | null>(null);

  const isDeleted = !!reply.deleted_at;
  const isEdited = !!reply.edited_at;
  const displayName = getDisplayName(profile, reply.user_id);
  const replyCount = threadCountsCtx?.replyCounts.get(reply.id) ?? 0;

  const canDelete = isOwn || hasPermission(userRole as 'owner' | 'admin' | 'member' | null, 'message:delete_any');
  const canPin = !!userId;

  useEffect(() => {
    if (isTempId(reply.id)) return;
    getMessageReactions(reply.id).then(setReactions);
  }, [reply.id]);

  useEffect(() => {
    function handleAttachmentsUpdated(e: Event) {
      const { messageId } = (e as CustomEvent).detail;
      if (messageId === reply.id) {
        invalidateAttachments(reply.id);
      }
    }
    window.addEventListener('attachments-updated', handleAttachmentsUpdated);
    return () => window.removeEventListener('attachments-updated', handleAttachmentsUpdated);
  }, [reply.id, invalidateAttachments]);

  useEffect(() => {
    function handleReactionsUpdated(e: Event) {
      const { messageId } = (e as CustomEvent).detail;
      if (messageId === reply.id) {
        invalidateMessageReactions(reply.id);
        getMessageReactions(reply.id).then(setReactions);
      }
    }
    window.addEventListener('reactions-updated', handleReactionsUpdated);
    return () => window.removeEventListener('reactions-updated', handleReactionsUpdated);
  }, [reply.id]);

  const reactionGroups = groupReactions(reactions, userId ?? '');

  const handleReact = useCallback(async (emoji: string) => {
    if (!userId) return;
    setReactions((prev) => {
      const existing = prev.find((r) => r.emoji === emoji && r.user_id === userId);
      if (existing) {
        return prev.filter((r) => r.id !== existing.id);
      }
      return [...prev, { id: `temp-${Date.now()}`, message_id: reply.id, user_id: userId, emoji, created_at: new Date().toISOString() }];
    });
    addReaction(reply.id, userId, emoji).then(() => {
      getMessageReactions(reply.id).then(setReactions);
    });
  }, [reply.id, userId]);

  const handlePopoverSelect = useCallback(async (emoji: string) => {
    if (!userId) return;
    setReactions((prev) => {
      const existing = prev.find((r) => r.emoji === emoji && r.user_id === userId);
      if (existing) {
        return prev.filter((r) => r.id !== existing.id);
      }
      return [...prev, { id: `temp-${Date.now()}`, message_id: reply.id, user_id: userId, emoji, created_at: new Date().toISOString() }];
    });
    setPopoverAnchor(null);
    addReaction(reply.id, userId, emoji).then(() => {
      getMessageReactions(reply.id).then(setReactions);
    });
  }, [reply.id, userId]);

  const handlePillClick = useCallback((e: React.MouseEvent<HTMLButtonElement>, group: { emoji: string; hasOwn: boolean }) => {
    if (reactionGroups.length > 3) {
      setPopoverAnchor(e.currentTarget);
    } else {
      handleReact(group.emoji);
    }
  }, [reactionGroups.length, handleReact]);

  const visibleReactions = reactionGroups.slice(0, 3);

  const handleRemoveLink = useCallback((url: string) => {
    setPendingRemoveUrl(url);
  }, []);

  const handleConfirmRemoveLink = useCallback(async () => {
    if (!pendingRemoveUrl) return;
    setIsRemovingLink(true);
    try {
      const newContent = removeUrlsFromText(reply.content, [pendingRemoveUrl]).trim();
      if (!newContent) {
        await deleteMessage(reply.id);
        if (reply.parent_id) {
          threadCountsCtx?.decrementReplyCount(reply.parent_id);
        }
      } else {
        const remainingUrls = extractUrls(newContent);
        const newLinkMode: LinkDisplayMode | null = remainingUrls.length > 0 ? 'embed' : 'text';
        await updateMessage(reply.id, newContent, newLinkMode);
      }
      setPendingRemoveUrl(null);
    } finally {
      setIsRemovingLink(false);
    }
  }, [pendingRemoveUrl, reply.id, reply.content, reply.parent_id, updateMessage, deleteMessage, threadCountsCtx]);

  const handleCancelRemoveLink = useCallback(() => {
    if (!isRemovingLink) {
      setPendingRemoveUrl(null);
    }
  }, [isRemovingLink]);

  const handleStartEdit = useCallback(() => {
    editCtx?.startEditing(reply);
  }, [reply, editCtx]);

  const handleRequestDelete = useCallback(() => {
    setShowDeleteDialog(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      await deleteMessage(reply.id);
      if (reply.parent_id) {
        threadCountsCtx?.decrementReplyCount(reply.parent_id);
      }
      setShowDeleteDialog(false);
    } finally {
      setIsDeleting(false);
    }
  }, [reply.id, reply.parent_id, deleteMessage, threadCountsCtx]);

  const handleCancelDelete = useCallback(() => {
    if (!isDeleting) {
      setShowDeleteDialog(false);
    }
  }, [isDeleting]);

  const handleOpenThread = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    threadCtx?.openThread(reply);
  }, [reply, threadCtx]);

  if (isDeleted) {
    return (
      <div className={`${styles.replyItem} ${styles.replyDeleted}`}>
        <div className={styles.deletedText}>This message was deleted</div>
      </div>
    );
  }

  return (
    <>
      <MessageContextMenu
        message={reply}
        isOwn={isOwn}
        canDelete={canDelete}
        onEdit={handleStartEdit}
        onDelete={handleRequestDelete}
      >
        <div
          className={`${styles.replyRow} ${isGrouped ? styles.replyGrouped : ''}`}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <div className={`${styles.replyItem} ${isOwn ? styles.replyOwn : ''}`}>
            <div className={styles.replyAvatar}>
              {isGrouped ? (
                <span className={styles.replyTimestampInline}>
                  {formatTime(reply.created_at)}
                </span>
              ) : (
                <UserProfilePopover userId={reply.user_id} side="right">
                  <Avatar
                    src={profile?.avatar_url || undefined}
                    name={displayName}
                    size="sm"
                  />
                </UserProfilePopover>
              )}
            </div>
            <div className={styles.replyContent}>
              {!isGrouped && (
                <div className={styles.replyHeader}>
                  <span className={styles.replyAuthor}>{displayName}</span>
                  <span className={styles.replyTime} title={new Date(reply.created_at).toLocaleString()}>
                    {formatRelativeTime(reply.created_at)}
                  </span>
                  {isEdited && <span className={styles.replyEdited}>(edited)</span>}
                </div>
              )}
              {(() => {
                const urls = extractUrls(reply.content);
                const linkMode = reply.link_mode ?? 'embed';
                const showLinkPreviews = linkMode === 'embed' && urls.length > 0;
                const displayContent = showLinkPreviews ? removeUrlsFromText(reply.content, urls) : reply.content;
                return (
                  <>
                    {displayContent.trim() && (
                      <div className={styles.replyText}>
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
                  <div className={styles.attachments}>
                    <AttachmentGrid
                      attachments={attachments}
                      messageId={reply.id}
                      creatorId={reply.user_id}
                      defaultLayout={reply.attachments_layout}
                      viewerId={userId}
                      compact
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

          <div className={`${styles.actionsBar} ${isHovered ? styles.actionsBarVisible : ''}`}>
            <MessageActions
              message={reply}
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
        message={reply}
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
