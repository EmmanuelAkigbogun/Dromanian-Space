import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useChannel } from '@/hooks/useChannel';
import { useAuth } from '@/hooks/useAuth';
import { useThreadCountsSafe } from '@/app/providers/ThreadProvider';
import { supabase } from '@/lib/supabase';
import {
  getChannelMessages,
  sendMessage as sendMessageService,
  updateMessage as updateMessageService,
  deleteMessage as deleteMessageService,
  getThreadMessageCounts,
} from '@/lib/message';
import type { LinkDisplayMode, Message } from '@/types';

export type ConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

interface FailedMessage {
  tempId: string;
  content: string;
  parentId?: string;
  linkMode?: LinkDisplayMode | null;
}

interface MessageContextValue {
  messages: Message[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  connectionStatus: ConnectionStatus;
  failedMessages: FailedMessage[];
  sendMessage: (content: string, parentId?: string, linkMode?: LinkDisplayMode | null) => Promise<Message | null>;
  updateMessage: (messageId: string, content: string, linkMode?: LinkDisplayMode | null) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  retryMessage: (tempId: string) => Promise<void>;
  removeFailedMessage: (tempId: string) => void;
  loadMore: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  clearError: () => void;
}

const MessageContext = createContext<MessageContextValue | null>(null);

interface MessageProviderProps {
  children: ReactNode;
}

export function MessageProvider({ children }: MessageProviderProps) {
  const { currentChannel, isMember } = useChannel();
  const { userId } = useAuth();
  const threadCountsCtx = useThreadCountsSafe();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [failedMessages, setFailedMessages] = useState<FailedMessage[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const instanceId = useRef(Math.random().toString(36).slice(2, 9)).current;
  const tempIdCounter = useRef(0);
  const reconnectCount = useRef(0);

  const channelId = currentChannel?.id;
  const workspaceId = currentChannel?.workspace_id;
  const isUserMember = channelId ? isMember(channelId) : false;

  const fetchMessages = useCallback(async () => {
    if (!channelId || !isUserMember) {
      setMessages([]);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const result = await getChannelMessages(channelId);
      setMessages(result.messages);
      setHasMore(result.hasMore);
    } catch {
      setError('Failed to load messages');
    } finally {
      setIsLoading(false);
    }
  }, [channelId, isUserMember]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  useEffect(() => {
    if (!channelId) {
      setConnectionStatus('connected');
      return;
    }

    setConnectionStatus('connecting');

    const channel = supabase
      .channel(`messages-realtime:${channelId}:${instanceId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          const newMessage = payload.new as Message;
          const parentId = newMessage.parent_id;
          if (parentId) {
            getThreadMessageCounts([parentId]).then((counts) => {
              const count = counts.get(parentId);
              if (count !== undefined) threadCountsCtx?.setReplyCount(parentId, count);
            });
            return;
          }
          setMessages((prev) => {
            if (prev.some((m) => m.id === newMessage.id)) return prev;
            const hasOptimistic = prev.some(
              (m) => m.id.startsWith('temp-') && m.user_id === newMessage.user_id && m.content === newMessage.content,
            );
            if (hasOptimistic) return prev;
            return [...prev, newMessage];
          });
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          const updated = payload.new as Message;
          setMessages((prev) =>
            prev.map((m) => (m.id === updated.id ? updated : m)),
          );
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          const deletedId = payload.old?.id;
          if (!deletedId) return;
          setMessages((prev) => prev.filter((m) => m.id !== deletedId));
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'file_attachments',
          filter: `workspace_id=eq.${workspaceId}`,
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
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'reactions',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          const reaction = payload.new as { message_id: string };
          const messageId = reaction?.message_id;
          if (messageId) {
            window.dispatchEvent(
              new CustomEvent('reactions-updated', {
                detail: { messageId },
              }),
            );
          }
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setConnectionStatus('connected');
        } else if (status === 'CHANNEL_ERROR') {
          setConnectionStatus('disconnected');
        } else if (status === 'TIMED_OUT') {
          setConnectionStatus('reconnecting');
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, reconnectCount.current]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Reconnect logic for disconnected/reconnecting states
  useEffect(() => {
    if (connectionStatus !== 'disconnected' && connectionStatus !== 'reconnecting') return;
    if (!channelId) return;

    const retryDelay = connectionStatus === 'disconnected' ? 5000 : 3000;
    const timer = setTimeout(() => {
      reconnectCount.current += 1;
      setConnectionStatus('connecting');
    }, retryDelay);

    return () => clearTimeout(timer);
  }, [connectionStatus, channelId]);

  const loadMore = useCallback(async () => {
    if (!channelId || isLoadingMore || !hasMore || messagesRef.current.length === 0) return;

    try {
      setIsLoadingMore(true);
      setError(null);

      const oldestMessage = messagesRef.current[0];
      const result = await getChannelMessages(channelId, {
        before: oldestMessage.created_at,
      });

      setMessages((prev) => [...result.messages, ...prev]);
      setHasMore(result.hasMore);
    } catch {
      setError('Failed to load older messages');
    } finally {
      setIsLoadingMore(false);
    }
  }, [channelId, isLoadingMore, hasMore]);

  const sendMessage = useCallback(
    async (content: string, parentId?: string, linkMode?: LinkDisplayMode | null): Promise<Message | null> => {
      if (!channelId || !userId) return null;

      setError(null);
      const tempId = `temp-${Date.now()}-${++tempIdCounter.current}`;

      const optimisticMessage: Message = {
        id: tempId,
        channel_id: channelId,
        user_id: userId,
        content: content.trim(),
        edited_at: null,
        deleted_at: null,
        parent_id: parentId ?? null,
        created_at: new Date().toISOString(),
        attachments_layout: null,
        link_mode: linkMode ?? null,
      };

      if (!parentId) {
        setMessages((prev) => [...prev, optimisticMessage]);
      }

      const message = await sendMessageService(channelId, userId, content, { parentId, linkMode });
      if (!message) {
        if (!parentId) {
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
        }
        setFailedMessages((prev) => [...prev, { tempId, content, parentId, linkMode }]);
        return null;
      }

      if (!parentId) {
        setMessages((prev) =>
          prev.map((m) => (m.id === tempId ? message : m)),
        );
      }
      return message;
    },
    [channelId, userId],
  );

  const retryMessage = useCallback(
    async (tempId: string): Promise<void> => {
      const failed = failedMessages.find((f) => f.tempId === tempId);
      if (!failed || !channelId || !userId) return;

      setFailedMessages((prev) => prev.filter((f) => f.tempId !== tempId));
      await sendMessage(failed.content, failed.parentId, failed.linkMode);
    },
    [failedMessages, channelId, userId, sendMessage],
  );

  const removeFailedMessage = useCallback((tempId: string) => {
    setFailedMessages((prev) => prev.filter((f) => f.tempId !== tempId));
  }, []);

  const updateMessageHandler = useCallback(
    async (messageId: string, content: string, linkMode?: LinkDisplayMode | null): Promise<void> => {
      setError(null);
      const updated = await updateMessageService(messageId, content, { linkMode });
      if (!updated) {
        setError('Failed to update message');
        return;
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? updated : m)),
      );
    },
    [],
  );

  const deleteMessageHandler = useCallback(
    async (messageId: string): Promise<void> => {
      setError(null);
      const success = await deleteMessageService(messageId, { userId: userId ?? undefined });
      if (!success) {
        setError('Failed to delete message');
        return;
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, deleted_at: new Date().toISOString() }
            : m,
        ),
      );
    },
    [userId],
  );

  const refreshMessages = useCallback(async () => {
    await fetchMessages();
  }, [fetchMessages]);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<MessageContextValue>(
    () => ({
      messages,
      isLoading,
      isLoadingMore,
      hasMore,
      error,
      connectionStatus,
      failedMessages,
      sendMessage,
      updateMessage: updateMessageHandler,
      deleteMessage: deleteMessageHandler,
      retryMessage,
      removeFailedMessage,
      loadMore,
      refreshMessages,
      clearError,
    }),
    [
      messages,
      isLoading,
      isLoadingMore,
      hasMore,
      error,
      connectionStatus,
      failedMessages,
      sendMessage,
      updateMessageHandler,
      deleteMessageHandler,
      retryMessage,
      removeFailedMessage,
      loadMore,
      refreshMessages,
      clearError,
    ],
  );

  return <MessageContext.Provider value={value}>{children}</MessageContext.Provider>;
}

export function useMessageContext(): MessageContextValue {
  const context = useContext(MessageContext);
  if (!context) {
    throw new Error('useMessageContext must be used within a MessageProvider');
  }
  return context;
}

export function useMessageContextSafe(): MessageContextValue | null {
  return useContext(MessageContext);
}
