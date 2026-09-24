import { useMemo } from 'react';
import { useMessageContext, useMessageContextSafe, type ConnectionStatus } from '@/app/providers/MessageProvider';
import type { LinkDisplayMode, Message } from '@/types';

interface FailedMessage {
  tempId: string;
  content: string;
  parentId?: string;
}

interface UseMessageReturn {
  messages: Message[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  connectionStatus: ConnectionStatus;
  failedMessages: FailedMessage[];
  sendMessage: (content: string, parentId?: string) => Promise<Message | null>;
  updateMessage: (messageId: string, content: string, linkMode?: LinkDisplayMode | null) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  retryMessage: (tempId: string) => Promise<void>;
  removeFailedMessage: (tempId: string) => void;
  loadMore: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  clearError: () => void;
}

export function useMessage(): UseMessageReturn {
  const ctx = useMessageContext();

  return useMemo(
    () => ({
      messages: ctx.messages,
      isLoading: ctx.isLoading,
      isLoadingMore: ctx.isLoadingMore,
      hasMore: ctx.hasMore,
      error: ctx.error,
      connectionStatus: ctx.connectionStatus,
      failedMessages: ctx.failedMessages,
      sendMessage: ctx.sendMessage,
      updateMessage: ctx.updateMessage,
      deleteMessage: ctx.deleteMessage,
      retryMessage: ctx.retryMessage,
      removeFailedMessage: ctx.removeFailedMessage,
      loadMore: ctx.loadMore,
      refreshMessages: ctx.refreshMessages,
      clearError: ctx.clearError,
    }),
    [
      ctx.messages,
      ctx.isLoading,
      ctx.isLoadingMore,
      ctx.hasMore,
      ctx.error,
      ctx.connectionStatus,
      ctx.failedMessages,
      ctx.sendMessage,
      ctx.updateMessage,
      ctx.deleteMessage,
      ctx.retryMessage,
      ctx.removeFailedMessage,
      ctx.loadMore,
      ctx.refreshMessages,
      ctx.clearError,
    ],
  );
}

const nullMessageReturn: UseMessageReturn = {
  messages: [],
  isLoading: false,
  isLoadingMore: false,
  hasMore: false,
  error: null,
  connectionStatus: 'disconnected',
  failedMessages: [],
  sendMessage: async () => null,
  updateMessage: async () => {},
  deleteMessage: async () => {},
  retryMessage: async () => {},
  removeFailedMessage: () => {},
  loadMore: async () => {},
  refreshMessages: async () => {},
  clearError: () => {},
};

export function useMessageSafe(): UseMessageReturn {
  const ctx = useMessageContextSafe();

  return useMemo(() => {
    if (!ctx) return nullMessageReturn;
    return {
      messages: ctx.messages,
      isLoading: ctx.isLoading,
      isLoadingMore: ctx.isLoadingMore,
      hasMore: ctx.hasMore,
      error: ctx.error,
      connectionStatus: ctx.connectionStatus,
      failedMessages: ctx.failedMessages,
      sendMessage: ctx.sendMessage,
      updateMessage: ctx.updateMessage,
      deleteMessage: ctx.deleteMessage,
      retryMessage: ctx.retryMessage,
      removeFailedMessage: ctx.removeFailedMessage,
      loadMore: ctx.loadMore,
      refreshMessages: ctx.refreshMessages,
      clearError: ctx.clearError,
    };
  }, [ctx]);
}
