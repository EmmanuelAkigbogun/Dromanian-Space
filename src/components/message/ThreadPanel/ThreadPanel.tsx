import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useThread, useThreadCounts } from '@/app/providers/ThreadProvider';
import { EditProvider } from '@/app/providers/EditProvider';
import { useProfiles } from '@/hooks/useProfiles';
import { usePrefetchAttachments } from '@/hooks/useMessageAttachments';
import { useAuth } from '@/hooks/useAuth';
import { getThreadMessages, getThreadMessageCounts, getMessageById, sendMessage as sendMessageService, shouldGroupWithPrevious } from '@/lib/message';
import { MessageItem } from '@/components/message/MessageItem';
import { MessageInput } from '@/components/message/MessageInput';
import type { LinkDisplayMode, Message } from '@/types';
import styles from './ThreadPanel.module.css';

export function ThreadPanel() {
  const { activeThread, openThread } = useThread();
  const { replyCounts, setReplyCount } = useThreadCounts();
  const { userId } = useAuth();
  const [replies, setReplies] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [parentMessage, setParentMessage] = useState<Message | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevReplyCountRef = useRef(0);

  const isNestedThread = !!activeThread?.parent_id;

  usePrefetchAttachments(replies.map((m) => m.id));

  const replyCount = activeThread ? replyCounts.get(activeThread.id) ?? 0 : 0;

  const uniqueUserIds = useMemo(
    () => [...new Set(replies.map((m) => m.user_id))],
    [replies],
  );
  const { profiles } = useProfiles(uniqueUserIds);

  const parentProfileIds = useMemo(
    () => activeThread ? [activeThread.user_id] : [],
    [activeThread],
  );
  const { profiles: parentProfiles } = useProfiles(parentProfileIds);

  const fetchReplies = useCallback(() => {
    if (!activeThread) return;
    setIsLoading(true);
    getThreadMessages(activeThread.id).then((data) => {
      setReplies(data);
      setIsLoading(false);
    });
  }, [activeThread]);

  const applyReplyInsert = useCallback((reply: Message) => {
    setReplies((prev) => {
      if (prev.some((m) => m.id === reply.id)) return prev;
      return [...prev, reply].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
    });
  }, []);

  const applyReplyUpdate = useCallback((updated: Message) => {
    setReplies((prev) => {
      if (updated.deleted_at) {
        return prev.filter((m) => m.id !== updated.id);
      }
      return prev.map((m) => (m.id === updated.id ? updated : m));
    });
  }, []);

  const applyReplyDelete = useCallback((deletedId: string) => {
    setReplies((prev) => prev.filter((m) => m.id !== deletedId));
  }, []);

  useEffect(() => {
    fetchReplies();
  }, [fetchReplies]);

  useEffect(() => {
    if (!activeThread?.parent_id) {
      setParentMessage(null);
      return;
    }
    getMessageById(activeThread.parent_id).then(setParentMessage);
  }, [activeThread?.parent_id]);

  // Realtime subscription for thread replies. Filters by channel_id (the same
  // filter the channel/DM feeds use successfully) and matches the thread
  // client-side, because a server-side `parent_id=eq.X` filter does not
  // reliably deliver events and left new auto-reply replies invisible until a
  // reload.
  useEffect(() => {
    if (!activeThread) return;
    const threadId = activeThread.id;
    const channelId = activeThread.channel_id;

    const matchesThread = (row: Record<string, unknown> | null): boolean =>
      !!row && String(row.parent_id ?? '') === threadId;

    const channel = supabase
      .channel(`thread:${threadId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` },
        (payload) => {
          if (matchesThread(payload.new as Record<string, unknown>)) {
            applyReplyInsert(payload.new as Message);
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` },
        (payload) => {
          if (matchesThread(payload.new as Record<string, unknown>)) {
            applyReplyUpdate(payload.new as Message);
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` },
        (payload) => {
          const old = payload.old as Record<string, unknown>;
          if (matchesThread(old)) {
            applyReplyDelete(String(old.id));
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeThread, applyReplyInsert, applyReplyUpdate, applyReplyDelete]);

  useEffect(() => {
    if (!activeThread) return;
    if (replies.length > prevReplyCountRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
    prevReplyCountRef.current = replies.length;
  }, [replies.length, activeThread]);

  const handleReplySent = useCallback(() => {}, []);

  useEffect(() => {
    if (replies.length === 0) return;
    const replyIds = replies.map((m) => m.id);
    getThreadMessageCounts(replyIds).then((counts) => {
      counts.forEach((count, parentId) => {
        if (count > 0) {
          setReplyCount(parentId, count);
        }
      });
    });
  }, [replies, setReplyCount]);

  const handleSendReply = useCallback(async (content: string, parentId?: string, linkMode?: LinkDisplayMode | null) => {
    if (!activeThread || !userId) return null;
    const trimmed = content.trim();
    const msg = await sendMessageService(activeThread.channel_id, userId, trimmed || ' ', { parentId: parentId ?? activeThread.id, linkMode });
    if (msg) applyReplyInsert(msg);
    return msg;
  }, [activeThread, userId, applyReplyInsert]);

  const handleBackToParent = useCallback(() => {
    if (parentMessage) {
      openThread(parentMessage);
    }
  }, [parentMessage, openThread]);

  if (!activeThread) return null;

  const parentProfile = parentProfiles.get(activeThread.user_id) ?? null;

  return (
    <EditProvider>
    <div className={styles.threadPanel}>
      {isNestedThread && parentMessage && (
        <div className={styles.backHeader}>
          <button type="button" className={styles.backButton} onClick={handleBackToParent}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back to parent thread
          </button>
        </div>
      )}

      <div className={styles.replies} ref={scrollRef}>
        <div className={styles.parentMessage}>
          <MessageItem
            message={activeThread}
            isOwn={activeThread.user_id === userId}
            profile={parentProfile}
            isGrouped={false}
            compact
          />
        </div>

        <div className={styles.divider}>
          <div className={styles.dividerLine} />
          <span>
            {replyCount === 0
              ? 'No replies yet'
              : `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
          </span>
          <div className={styles.dividerLine} />
        </div>

        {isLoading ? (
          <div className={styles.loading}>
            <span className={styles.loadingText}>Loading replies...</span>
          </div>
        ) : replies.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyText}>No replies yet. Be the first to reply!</span>
          </div>
        ) : (
          <div className={styles.replyList}>
            {replies.map((reply, index) => {
              const previousReply = index > 0 ? replies[index - 1] : undefined;
              const isGrouped = shouldGroupWithPrevious(reply, previousReply);
              const replyProfile = profiles.get(reply.user_id) ?? null;

              return (
                <MessageItem
                  key={reply.id}
                  message={reply}
                  isOwn={reply.user_id === userId}
                  profile={replyProfile}
                  isGrouped={isGrouped}
                  compact
                />
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.inputArea}>
        <MessageInput
          parentId={activeThread.id}
          placeholder="Reply..."
          onSend={handleSendReply}
          overrideChannelId={activeThread.channel_id}
          onMessageSent={handleReplySent}
        />
      </div>
    </div>
    </EditProvider>
  );
}
