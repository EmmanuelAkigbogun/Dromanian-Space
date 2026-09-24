import { useMemo } from 'react';
import { useConversationContext } from '@/app/providers/ConversationProvider';
import type { ConversationWithParticipants, DirectConversation, ConversationParticipant } from '@/lib/conversation';
import type { Profile } from '@/types';

interface UseConversationReturn {
  conversations: ConversationWithParticipants[];
  currentConversation: DirectConversation | null;
  currentParticipants: (ConversationParticipant & { profile: Profile | null })[];
  isLoading: boolean;
  error: string | null;
  hasConversations: boolean;
  switchConversation: (conversationId: string) => Promise<void>;
  startDm: (otherUserId: string) => Promise<DirectConversation | null>;
  startGroup: (participantIds: string[], name: string) => Promise<DirectConversation | null>;
  refreshConversations: () => Promise<void>;
  clearCurrentConversation: () => void;
  clearError: () => void;
}

export function useConversation(): UseConversationReturn {
  const ctx = useConversationContext();

  return useMemo(
    () => ({
      conversations: ctx.conversations,
      currentConversation: ctx.currentConversation,
      currentParticipants: ctx.currentParticipants,
      isLoading: ctx.isLoading,
      error: ctx.error,
      hasConversations: ctx.hasConversations,
      switchConversation: ctx.switchConversation,
      startDm: ctx.startDm,
      startGroup: ctx.startGroup,
      refreshConversations: ctx.refreshConversations,
      clearCurrentConversation: ctx.clearCurrentConversation,
      clearError: ctx.clearError,
    }),
    [
      ctx.conversations,
      ctx.currentConversation,
      ctx.currentParticipants,
      ctx.isLoading,
      ctx.error,
      ctx.hasConversations,
      ctx.switchConversation,
      ctx.startDm,
      ctx.startGroup,
      ctx.refreshConversations,
      ctx.clearCurrentConversation,
      ctx.clearError,
    ],
  );
}
