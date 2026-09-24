import { useEffect, useState, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useConversation } from '@/hooks/useConversation';
import { usePresenceContext } from '@/app/providers/PresenceProvider';
import { getChannelMessages, sendMessage as sendMessageService, updateMessage as updateMessageService, deleteMessage as deleteMessageService, getThreadMessageCounts } from '@/lib/message';
import { getProfile } from '@/lib/profile';
import { MessageInput } from '@/components/message/MessageInput';
import { MessageItem } from '@/components/message/MessageItem';
import { MessageEmpty } from '@/components/message/MessageEmpty';
import { MessageLoading } from '@/components/message/MessageLoading';
import { DateSeparator } from '@/components/message/DateSeparator';
import { ConnectionIndicator } from '@/components/message/ConnectionIndicator';
import { FailedMessageBanner } from '@/components/message/FailedMessageBanner';
import { PinnedMessagesPanel } from '@/components/message/PinnedMessagesPanel';
import { MessageSelectionBanner } from '@/components/message/MessageSelectionBanner';
import { Avatar } from '@/components/ui/Avatar';
import { AvatarDisplay } from '@/components/ui/AvatarDisplay';
import { Dialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/Spinner';
import { getDisplayName, shouldGroupWithPrevious, needsDateSeparator } from '@/lib/message';
import { getPresenceLabel, presenceToAvatarStatus } from '@/lib/presence';
import { supabase } from '@/lib/supabase';
import { useThreadCountsSafe, useThread } from '@/app/providers/ThreadProvider';
import { usePrefetchAttachments } from '@/hooks/useMessageAttachments';
import { useBulkMessageActions } from '@/hooks/useBulkMessageActions';
import { ShareMessageDialog } from '@/components/message/ShareMessageDialog';
import { BulkDeleteConfirmDialog } from '@/components/message/BulkDeleteConfirmDialog';
import { CallButton } from '@/components/call';
import type { LinkDisplayMode, Message, Profile } from '@/types';
import type { ConnectionStatus } from '@/app/providers/MessageProvider';
import styles from './DmConversationView.module.css';

interface FailedMsg {
  tempId: string;
  content: string;
}

export function DmConversationView() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const { currentConversation, currentParticipants, conversations, switchConversation, clearCurrentConversation } = useConversation();
  const { presenceMap } = usePresenceContext();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [failedMessages, setFailedMessages] = useState<FailedMsg[]>([]);
  const [profileModalUserId, setProfileModalUserId] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  const [showPinned, setShowPinned] = useState(false);
  const [pinnedMenuOpen, setPinnedMenuOpen] = useState(false);
  const pinnedMenuRef = useRef<HTMLDivElement>(null);
  const { activeThread } = useThread();
  const bulk = useBulkMessageActions();
  const messagesRef = useRef<Message[]>([]);
  const tempIdCounter = useRef(0);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevLenRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const scrollRestoreRef = useRef<{ prevScrollTop: number; prevScrollHeight: number } | null>(null);
  const didInitScrollRef = useRef<string | null>(null);
  const threadCountsCtx = useThreadCountsSafe();

  const participantProfiles = useMemo(() => {
    const map = new Map<string, import('@/types').Profile>();
    if (!currentParticipants) return map;
    for (const p of currentParticipants) {
      if (p.profile) map.set(p.user_id, p.profile);
    }
    return map;
  }, [currentParticipants]);

  const channelId = currentConversation?.channel_id;

  usePrefetchAttachments(messages.map((m) => m.id));

  useEffect(() => {
    if (conversationId && currentConversation?.id !== conversationId) {
      switchConversation(conversationId);
    }
  }, [conversationId, currentConversation?.id, switchConversation]);

  useEffect(() => {
    if (!conversationId && currentConversation) {
      clearCurrentConversation();
    }
  }, [conversationId, currentConversation, clearCurrentConversation]);

  useEffect(() => {
    if (!channelId || !userId) {
      setMessages([]);
      setIsLoading(false);
      return;
    }

    didInitScrollRef.current = null;
    prevLenRef.current = 0;
    atBottomRef.current = true;
    scrollRestoreRef.current = null;
    setMessages([]);
    setFailedMessages([]);
    setHasMore(false);
    setIsLoading(true);

    let cancelled = false;

    async function load() {
      const result = await getChannelMessages(channelId!);
      if (!cancelled) {
        setMessages(result.messages);
        setHasMore(result.hasMore);
        setIsLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [channelId, userId]);

  useEffect(() => {
    const el = scrollAreaRef.current;
    const currentChannelId = channelId;
    if (!el || !currentChannelId) return;
    function onScroll() {
      const area = el as HTMLDivElement;
      atBottomRef.current = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [channelId]);

  useLayoutEffect(() => {
    const container = scrollAreaRef.current;
    if (!container) return;
    if (scrollRestoreRef.current) {
      const { prevScrollTop, prevScrollHeight } = scrollRestoreRef.current;
      scrollRestoreRef.current = null;
      loadingOlderRef.current = false;
      prevLenRef.current = messages.length;
      container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
      return;
    }
    const newMsgArrived = messages.length > prevLenRef.current;
    prevLenRef.current = messages.length;
    if (newMsgArrived && atBottomRef.current && messages.length > 0 && !loadingOlderRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const container = scrollAreaRef.current;
    if (!container || isLoading || messages.length === 0) return;
    if (didInitScrollRef.current === channelId) return;
    didInitScrollRef.current = channelId ?? null;
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }, [isLoading, channelId, messages.length]);

  useEffect(() => {
    if (!channelId) return;

    setConnectionStatus('connecting');

    const ch = supabase
      .channel(`dm-realtime:${channelId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` },
        (payload) => {
          const msg = payload.new as Message;
          const parentId = msg.parent_id;
          if (parentId) {
            getThreadMessageCounts([parentId]).then((counts) => {
              const count = counts.get(parentId);
              if (count !== undefined) threadCountsCtx?.setReplyCount(parentId, count);
            });
            return;
          }
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            const hasOptimistic = prev.some(
              (m) => m.id.startsWith('temp-') && m.user_id === msg.user_id && m.content === msg.content,
            );
            if (hasOptimistic) return prev;
            return [...prev, msg];
          });
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` },
        (payload) => {
          const updated = payload.new as Message;
          setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` },
        (payload) => {
          const deletedId = payload.old?.id;
          if (deletedId) setMessages((prev) => prev.filter((m) => m.id !== deletedId));
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'file_attachments',
          filter: `workspace_id=eq.${currentWorkspace?.id}`,
        },
        (payload) => {
          const attachment = payload.new as { message_id: string };
          if (attachment?.message_id) {
            window.dispatchEvent(
              new CustomEvent('attachments-updated', {
                detail: { messageId: attachment.message_id },
              }),
            );
          }
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setConnectionStatus('connected');
        else if (status === 'CHANNEL_ERROR') setConnectionStatus('disconnected');
        else if (status === 'TIMED_OUT') setConnectionStatus('reconnecting');
      });

    return () => { supabase.removeChannel(ch); };
  }, [channelId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!threadCountsCtx || messages.length === 0) return;
    const messageIds = messages.map((m) => m.id);
    getThreadMessageCounts(messageIds).then((counts) => {
      counts.forEach((count, parentId) => {
        if (count > 0) {
          threadCountsCtx.setReplyCount(parentId, count);
        }
      });
    });
  }, [messages]);

  const loadMore = useCallback(async () => {
    if (!channelId || isLoadingMore || !hasMore || messagesRef.current.length === 0) return;
    setIsLoadingMore(true);
    loadingOlderRef.current = true;
    const container = scrollAreaRef.current;
    const prevScrollTop = container?.scrollTop ?? 0;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    const oldest = messagesRef.current[0];
    const result = await getChannelMessages(channelId, { before: oldest.created_at });
    setMessages((prev) => {
      const existing = new Set(prev.map((m) => m.id));
      const fresh = result.messages.filter((m) => !existing.has(m.id));
      return [...fresh, ...prev];
    });
    scrollRestoreRef.current = { prevScrollTop, prevScrollHeight };
    setHasMore(result.hasMore);
    setIsLoadingMore(false);
  }, [channelId, isLoadingMore, hasMore]);

  const handleSendMessage = useCallback(async (content: string, _parentId?: string, linkMode?: LinkDisplayMode | null) => {
    if (!channelId || !userId) return null;

    const trimmed = content.trim();
    const tempId = `temp-${Date.now()}-${++tempIdCounter.current}`;
    const optimistic: Message = {
      id: tempId, channel_id: channelId, user_id: userId, content: trimmed || ' ',
      edited_at: null, deleted_at: null, parent_id: null, created_at: new Date().toISOString(),
      attachments_layout: null,
      link_mode: linkMode ?? null,
    };
    setMessages((prev) => [...prev, optimistic]);
    requestAnimationFrame(() => {
      const container = scrollAreaRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });

    const msg = await sendMessageService(channelId, userId, trimmed || ' ', { linkMode });
    if (!msg) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setFailedMessages((prev) => [...prev, { tempId, content: trimmed || ' ' }]);
      return null;
    }
    setMessages((prev) => {
      const withoutTemp = prev.filter((m) => m.id !== tempId);
      if (withoutTemp.some((m) => m.id === msg.id)) {
        return withoutTemp;
      }
      return [...withoutTemp, msg];
    });
    return msg;
  }, [channelId, userId]);

  const handleRetry = useCallback(async (tempId: string) => {
    const failed = failedMessages.find((f) => f.tempId === tempId);
    if (!failed) return;
    setFailedMessages((prev) => prev.filter((f) => f.tempId !== tempId));
    await handleSendMessage(failed.content);
  }, [failedMessages, handleSendMessage]);

  const handleRemoveFailed = useCallback((tempId: string) => {
    setFailedMessages((prev) => prev.filter((f) => f.tempId !== tempId));
  }, []);

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    if (!channelId || !userId) return;
    await deleteMessageService(messageId, { userId });
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }, [channelId, userId]);

  const handleEditMessage = useCallback(async (messageId: string, newContent: string, linkMode?: LinkDisplayMode | null) => {
    if (!channelId) return;
    await updateMessageService(messageId, newContent, { linkMode });
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content: newContent, edited_at: new Date().toISOString(), link_mode: linkMode ?? null } : m)));
  }, [channelId]);

  const handleRemoveLink = useCallback(async (messageId: string, url: string) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg) return;
    const { removeUrlsFromText, extractUrls } = await import('@/lib/message/richText');
    const newContent = removeUrlsFromText(msg.content, [url]).trim();
    if (!newContent) {
      await handleDeleteMessage(messageId);
    } else {
      const remainingUrls = extractUrls(newContent);
      const newLinkMode: LinkDisplayMode | null = remainingUrls.length > 0 ? 'embed' : 'text';
      await handleEditMessage(messageId, newContent, newLinkMode);
    }
  }, [messages, handleDeleteMessage, handleEditMessage]);

  const editingMessage = useRef<import('@/types').Message | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  const handleStartEdit = useCallback((message: import('@/types').Message) => {
    editingMessage.current = message;
    setIsEditing(true);
  }, []);

  const handleSaveEdit = useCallback(async (newContent: string, linkMode?: LinkDisplayMode | null) => {
    const msg = editingMessage.current;
    if (!msg) return;
    await handleEditMessage(msg.id, newContent, linkMode);
    setIsEditing(false);
    editingMessage.current = null;
  }, [handleEditMessage]);

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    editingMessage.current = null;
  }, []);

  const virtualItems = useMemo(() => {
    const items: Array<{ type: string; id: string; data?: unknown }> = [];
    if (hasMore) items.push({ type: 'load-more', id: 'load-more' });
    messages.forEach((message, index) => {
      const prev = index > 0 ? messages[index - 1] : undefined;
      if (needsDateSeparator(message, prev)) {
        items.push({ type: 'date-separator', id: `date-${message.created_at}`, data: message.created_at });
      }
      items.push({ type: 'message', id: message.id, data: { message, isGrouped: shouldGroupWithPrevious(message, prev) } });
    });
    return items;
  }, [messages, hasMore]);

  const otherProfile = useMemo(() => {
    if (!currentParticipants || !userId) return null;
    if (currentConversation?.type !== 'dm') return null;
    const other = currentParticipants.find((p) => p.user_id !== userId);
    if (other) return other.profile ?? null;
    const self = currentParticipants.find((p) => p.user_id === userId);
    return self?.profile ?? null;
  }, [currentParticipants, userId, currentConversation?.type]);

  useEffect(() => {
    if (!profileModalUserId) {
      setSelectedProfile(null);
      return;
    }
    let cancelled = false;
    setProfileLoading(true);
    getProfile(profileModalUserId).then((p) => {
      if (!cancelled) {
        setSelectedProfile(p);
        setProfileLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [profileModalUserId]);

  const handleHeaderProfileClick = useCallback(() => {
    if (currentConversation?.type === 'group') {
      setGroupInfoOpen(true);
      return;
    }
    if (otherProfile) setProfileModalUserId(otherProfile.id);
  }, [currentConversation?.type, otherProfile]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (pinnedMenuRef.current && !pinnedMenuRef.current.contains(event.target as Node)) {
        setPinnedMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!currentConversation) {
    if (conversations.length === 0) {
      return (
        <div className={styles.container}>
          <div className={styles.empty}>
            <p>No conversations yet. Start a new one.</p>
          </div>
        </div>
      );
    }

    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.headerInfo}>
            <h2 className={styles.headerName}>Messages</h2>
          </div>
        </div>
        <div className={styles.messageArea}>
          <div className={styles.conversationList}>
            {conversations.map((conv) => {
              const isGroup = conv.type === 'group';
              const other = isGroup
                ? null
                : (conv.participants.find((p) => p.user_id !== userId) ?? conv.participants[0])?.profile ?? null;
              const name = conv.name || (other ? `${other.display_name || other.username || 'User'}` : 'Conversation');
              const avatar = conv.avatar_url || other?.avatar_url || null;

              return (
                <button
                  key={conv.id}
                  type="button"
                  className={styles.conversationItem}
                  onClick={() => navigate(`/dm/${conv.id}`)}
                >
                  {isGroup ? (
                    <div className={styles.groupAvatar}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                    </div>
                  ) : (
                    <Avatar src={avatar ?? undefined} name={name} size="sm" status={other && presenceMap.get(other.id)?.status === 'online' ? 'online' : null} />
                  )}
                  <div className={styles.conversationInfo}>
                    <span className={styles.conversationName}>{name}</span>
                    {isGroup && conv.participants.length > 0 && (
                      <span className={styles.conversationMeta}>{conv.participants.length} members</span>
                    )}
                    {!isGroup && other && (
                      <span className={styles.conversationMeta}>{other.status || 'offline'}</span>
                    )}
                  </div>
                  {conv.lastMessage && (
                    <span className={styles.conversationPreview}>{conv.lastMessage.content}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return <MessageLoading />;
  }

  const displayName = otherProfile
    ? getDisplayName(otherProfile, otherProfile.id)
    : currentConversation.name || 'Conversation';
  const displayAvatar = otherProfile?.avatar_url ?? currentConversation.avatar_url;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button type="button" className={styles.headerProfileButton} onClick={handleHeaderProfileClick}>
          <Avatar src={displayAvatar ?? undefined} name={displayName} size="sm" status={presenceToAvatarStatus(otherProfile ? presenceMap.get(otherProfile.id)?.status : 'offline')} />
        </button>
        <div className={styles.headerInfo}>
          <button type="button" className={styles.headerNameButton} onClick={handleHeaderProfileClick}>
            <h2 className={styles.headerName}>{displayName}</h2>
          </button>
          {currentConversation.type === 'group' && currentParticipants && (
            <span className={styles.headerSubtitle}>{currentParticipants.length} members</span>
          )}
        </div>
        <div className={styles.pinnedMenuContainer} ref={pinnedMenuRef}>
          <button
            type="button"
            className={`${styles.headerIconButton} ${pinnedMenuOpen || showPinned ? styles.headerIconButtonActive : ''}`}
            onClick={() => setPinnedMenuOpen((prev) => !prev)}
            aria-label="More options"
            aria-expanded={pinnedMenuOpen}
            aria-haspopup="menu"
            title="More options"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="5" r="1" />
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="19" r="1" />
            </svg>
          </button>
          {pinnedMenuOpen && (
            <div className={styles.pinnedMenu} role="menu">
              {bulk.selectedCount > 0 && (
                <>
                  <div className={styles.pinnedMenuSectionLabel}>
                    {bulk.selectedCount} selected
                  </div>
                  <button
                    type="button"
                    className={styles.pinnedMenuItem}
                    role="menuitem"
                    onClick={() => {
                      setPinnedMenuOpen(false);
                      bulk.openBulkForward();
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                    </svg>
                    Forward
                  </button>
                  <button
                    type="button"
                    className={`${styles.pinnedMenuItem} ${styles.pinnedMenuItemDanger}`}
                    role="menuitem"
                    onClick={() => {
                      setPinnedMenuOpen(false);
                      bulk.openBulkDelete();
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                    Delete
                  </button>
                  <button
                    type="button"
                    className={styles.pinnedMenuItem}
                    role="menuitem"
                    onClick={() => {
                      setPinnedMenuOpen(false);
                      bulk.clearSelection();
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                    Cancel
                  </button>
                  <div className={styles.pinnedMenuDivider} />
                </>
              )}
              <button
                type="button"
                className={`${styles.pinnedMenuItem} ${showPinned ? styles.pinnedMenuItemActive : ''}`}
                role="menuitem"
                onClick={() => {
                  setPinnedMenuOpen(false);
                  setShowPinned((prev) => !prev);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="17" x2="12" y2="22" />
                  <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V17z" />
                </svg>
                {showPinned ? 'Hide pinned' : 'Pinned messages'}
              </button>
            </div>
          )}
        </div>
        <CallButton
          targetUserId={otherProfile?.id ?? (currentConversation.type === 'group' && currentParticipants && currentParticipants.length > 0 ? currentParticipants.find((p) => p.user_id !== userId)?.user_id : undefined)}
          participantIds={currentParticipants?.map((p) => p.user_id)}
          callType={currentConversation.type === 'group' ? 'group' : 'direct'}
        />
      </div>

      <ConnectionIndicator status={connectionStatus} />

      <MessageSelectionBanner />

      <div className={styles.dmBody}>
        <div className={styles.messageArea} ref={scrollAreaRef}>
          {messages.length === 0 ? (
            <MessageEmpty channelName={displayName} />
          ) : (
            <div className={styles.messageList}>
              {virtualItems.map((item) => (
                <div key={item.id}>
                  {item.type === 'date-separator' && <DateSeparator date={item.data as string} />}
                  {item.type === 'message' && (() => {
                    const data = item.data as { message: Message; isGrouped: boolean };
                    return (
                      <MessageItem
                        message={data.message}
                        isOwn={data.message.user_id === userId}
                        profile={participantProfiles.get(data.message.user_id) ?? null}
                        isGrouped={data.isGrouped}
                        onDeleteMessage={handleDeleteMessage}
                        onRemoveLink={handleRemoveLink}
                        onStartEdit={handleStartEdit}
                      />
                    );
                  })()}
                  {item.type === 'load-more' && (
                    <div className={styles.loadMore}>
                      <button type="button" className={styles.loadMoreButton} onClick={loadMore} disabled={isLoadingMore}>
                        {isLoadingMore ? 'Loading...' : 'Load older messages'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {showPinned && channelId && (
          <div className={`${styles.dmPinnedPanel} ${activeThread ? styles.dmPinnedPanelWithThread : ''}`}>
            <PinnedMessagesPanel
              channelId={channelId}
              onClose={() => setShowPinned(false)}
              showSearch={false}
              showChannelNames={false}
            />
          </div>
        )}
      </div>

      {failedMessages.map((fm) => (
        <FailedMessageBanner
          key={fm.tempId}
          content={fm.content}
          tempId={fm.tempId}
          onRetry={handleRetry}
          onRemove={handleRemoveFailed}
        />
      ))}

      <MessageInput
        placeholder={`Message ${displayName}`}
        onSend={handleSendMessage}
        overrideChannelId={channelId}
        conversationId={currentConversation?.id}
        editingMessage={isEditing ? editingMessage.current : null}
        onSaveEdit={handleSaveEdit}
        onCancelEdit={handleCancelEdit}
      />

      <ShareMessageDialog
        open={bulk.forwardOpen}
        onClose={bulk.closeBulkForward}
        message={bulk.selectedMessages[0]}
        messages={bulk.selectedMessages}
        excludeChannelId={channelId}
      />
      <BulkDeleteConfirmDialog
        open={bulk.deleteOpen}
        onClose={bulk.closeBulkDelete}
        onConfirm={bulk.deleteSelected}
        count={bulk.deletableCount}
        totalCount={bulk.selectedCount}
        isDeleting={bulk.isDeleting}
      />

      <Dialog open={groupInfoOpen} onClose={() => setGroupInfoOpen(false)} title="Group info" size="sm">
        <div className={styles.groupInfoDialog}>
          <Avatar src={currentConversation.avatar_url ?? undefined} name={displayName} size="lg" />
          <span className={styles.groupInfoName}>{displayName}</span>
          {currentConversation.name && (
            <span className={styles.groupInfoHandle}>@{currentConversation.name}</span>
          )}
          <span className={styles.groupInfoMeta}>
            {currentParticipants ? currentParticipants.length : 0}{' '}
            member{currentParticipants && currentParticipants.length !== 1 ? 's' : ''}
          </span>
          <div className={styles.groupMembersList}>
            {currentParticipants?.map((p) => {
              const profile = p.profile ?? participantProfiles.get(p.user_id) ?? null;
              const name = profile ? getDisplayName(profile, profile.id) : 'Unknown';
              return (
                <button
                  key={p.user_id}
                  type="button"
                  className={styles.groupMemberItem}
                  onClick={() => {
                    setGroupInfoOpen(false);
                    setProfileModalUserId(p.user_id);
                  }}
                >
                  <Avatar
                    src={profile?.avatar_url ?? undefined}
                    name={name}
                    size="sm"
                    status={presenceToAvatarStatus(presenceMap.get(p.user_id)?.status ?? 'offline')}
                  />
                  <span className={styles.groupMemberName}>{name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </Dialog>

      <Dialog open={!!profileModalUserId} onClose={() => setProfileModalUserId(null)} title="Profile" size="sm">
        {profileLoading ? (
          <div className={styles.profileLoading}>
            <Spinner size="sm" />
          </div>
        ) : selectedProfile ? (
          <div className={styles.profileDialog}>
            <AvatarDisplay
              src={selectedProfile.avatar_url ?? undefined}
              name={selectedProfile.display_name || selectedProfile.username || selectedProfile.email}
              size="lg"
              style={selectedProfile.avatar_style ?? 'circle'}
              status={presenceToAvatarStatus(profileModalUserId ? presenceMap.get(profileModalUserId)?.status : 'offline')}
            />
            <span className={styles.profileName}>
              {selectedProfile.display_name || selectedProfile.username || 'Unknown'}
            </span>
            {selectedProfile.username && selectedProfile.display_name && (
              <span className={styles.profileUsername}>@{selectedProfile.username}</span>
            )}
            {selectedProfile.bio && (
              <p className={styles.profileBio}>{selectedProfile.bio}</p>
            )}
            <span className={styles.profileStatus}>
              {getPresenceLabel(profileModalUserId ? presenceMap.get(profileModalUserId)?.status : 'offline')}
            </span>
            {selectedProfile.timezone && (
              <span className={styles.profileLocalTime}>
                Local time ·{' '}
                {new Date().toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                  timeZone: selectedProfile.timezone,
                })}
              </span>
            )}
          </div>
        ) : (
          <p className={styles.profileNotFound}>Profile not found</p>
        )}
      </Dialog>
    </div>
  );
}
