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
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import {
  getUserConversations,
  getOrCreateDmConversation,
  getOrCreateGroupConversation,
  getConversationById,
  getConversationParticipants,
  type ConversationWithParticipants,
  type DirectConversation,
  type ConversationParticipant,
} from '@/lib/conversation';
import type { Profile } from '@/types';

interface ConversationContextValue {
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

const ConversationContext = createContext<ConversationContextValue | null>(null);

const STORAGE_KEY = 'dark-space-dm';

function getStoredConversationId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeConversationId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage not available
  }
}

function clearStoredConversationId(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage not available
  }
}

interface ConversationProviderProps {
  children: ReactNode;
}

export function ConversationProvider({ children }: ConversationProviderProps) {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const [conversations, setConversations] = useState<ConversationWithParticipants[]>([]);
  const [currentConversation, setCurrentConversation] = useState<DirectConversation | null>(null);
  const [currentParticipants, setCurrentParticipants] = useState<(ConversationParticipant & { profile: Profile | null })[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hasConversations = conversations.length > 0;

  const clearError = useCallback(() => setError(null), []);

  // Clear current conversation immediately when workspace changes
  const prevWorkspaceIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prevId = prevWorkspaceIdRef.current;
    const nextId = currentWorkspace?.id;
    prevWorkspaceIdRef.current = nextId;
    // Only clear on actual workspace switch (not on initial load)
    if (prevId && nextId && prevId !== nextId) {
      setCurrentConversation(null);
      setCurrentParticipants([]);
      clearStoredConversationId();
      setConversations([]);
      if (location.pathname === '/dm' || location.pathname.startsWith('/dm/')) {
        navigate('/dm', { replace: true });
      }
    }
  }, [currentWorkspace?.id]);

  const fetchConversations = useCallback(async () => {
    if (!userId || !currentWorkspace) {
      setConversations([]);
      setCurrentConversation(null);
      setCurrentParticipants([]);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const data = await getUserConversations(userId, currentWorkspace.id);
      setConversations(data);

      const storedId = getStoredConversationId();
      if (storedId) {
        const stored = data.find((c) => c.id === storedId);
        if (stored) {
          setCurrentConversation(stored);
          setCurrentParticipants(stored.participants);
          return;
        }
      }

      setCurrentConversation(null);
      setCurrentParticipants([]);
      clearStoredConversationId();
    } catch {
      setError('Failed to load conversations');
    } finally {
      setIsLoading(false);
    }
  }, [userId, currentWorkspace]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const switchConversation = useCallback(
    async (conversationId: string) => {
      setError(null);

      let conv = conversations.find((c) => c.id === conversationId);
      if (!conv) {
        const fetched = await getConversationById(conversationId);
        if (!fetched) {
          setError('Conversation not found');
          return;
        }

        if (currentWorkspace && fetched.workspace_id !== currentWorkspace.id) {
          navigate('/dm', { replace: true });
          return;
        }

        const participants = await getConversationParticipants(conversationId);
        conv = { ...fetched, participants } as ConversationWithParticipants;
      }

      setCurrentConversation(conv);
      setCurrentParticipants(conv.participants);
      storeConversationId(conversationId);

      if (currentWorkspace) {
        setConversations((prev) => {
          const updated = prev.map((c) =>
            c.id === conversationId ? { ...c, updated_at: new Date().toISOString() } : c,
          );
          return updated.sort((a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
          );
        });
      }
    },
    [conversations, currentWorkspace],
  );

  const startDm = useCallback(
    async (otherUserId: string): Promise<DirectConversation | null> => {
      if (!userId || !currentWorkspace) return null;

      setError(null);
      const conv = await getOrCreateDmConversation(currentWorkspace.id, userId, otherUserId);
      if (!conv) {
        setError('Failed to create conversation');
        return null;
      }

      await fetchConversations();
      await switchConversation(conv.id);
      return conv;
    },
    [userId, currentWorkspace, fetchConversations, switchConversation],
  );

  const startGroup = useCallback(
    async (participantIds: string[], name: string): Promise<DirectConversation | null> => {
      if (!userId || !currentWorkspace) return null;

      setError(null);
      const conv = await getOrCreateGroupConversation(currentWorkspace.id, userId, participantIds, name);
      if (!conv) {
        setError('Failed to create group conversation');
        return null;
      }

      await fetchConversations();
      await switchConversation(conv.id);
      return conv;
    },
    [userId, currentWorkspace, fetchConversations, switchConversation],
  );

  // Realtime: update participant profiles when profiles change
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel('conversation-profiles-realtime')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles' },
        (payload) => {
          const updated = payload.new as Profile;
          if (!updated?.id) return;
          setConversations((prev) =>
            prev.map((conv) => ({
              ...conv,
              participants: conv.participants.map((p) =>
                p.user_id === updated.id ? { ...p, profile: updated } : p,
              ),
            })),
          );
          setCurrentParticipants((prev) =>
            prev.map((p) =>
              p.user_id === updated.id ? { ...p, profile: updated } : p,
            ),
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  // Realtime: keep the sidebar last message in sync when messages are
  // inserted, edited, or deleted (deleted messages must drop off the list).
  useEffect(() => {
    if (!userId || conversations.length === 0) return;

    const channelIds = new Set(conversations.map((c) => c.channel_id));

    const applyLastMessage = async (channelId: string) => {
      if (!channelIds.has(channelId)) return;
      const { data } = await (supabase as any).rpc('get_last_messages_for_channels', {
        p_channel_ids: [channelId],
      });
      const last = (data ?? [])[0] as
        | { content: string; created_at: string; user_id: string }
        | undefined;
      setConversations((prev) => {
        const updated = prev.map((conv) =>
          conv.channel_id === channelId
            ? {
                ...conv,
                lastMessage: last
                  ? { content: last.content, created_at: last.created_at, user_id: last.user_id }
                  : null,
                updated_at: last ? last.created_at : conv.updated_at,
              }
            : conv,
        );
        return updated.sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        );
      });
    };

    const channel = supabase
      .channel('dm-last-message-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const newMsg = payload.new as {
            channel_id: string;
            content: string;
            created_at: string;
            user_id: string;
          };
          if (!channelIds.has(newMsg.channel_id)) return;
          setConversations((prev) => {
            const updated = prev.map((conv) =>
              conv.channel_id === newMsg.channel_id
                ? {
                    ...conv,
                    lastMessage: {
                      content: newMsg.content,
                      created_at: newMsg.created_at,
                      user_id: newMsg.user_id,
                    },
                    updated_at: newMsg.created_at,
                  }
                : conv,
            );
            return updated.sort(
              (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
            );
          });
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        (payload) => {
          const updated = payload.new as { channel_id: string };
          if (!channelIds.has(updated.channel_id)) return;
          applyLastMessage(updated.channel_id);
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'messages' },
        (payload) => {
          const deleted = payload.old as { channel_id: string };
          if (!channelIds.has(deleted.channel_id)) return;
          applyLastMessage(deleted.channel_id);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, conversations.length]);

  // Realtime: remove conversations from sidebar when deleted
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel('dm-conversation-deleted-realtime')
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'direct_conversations' },
        (payload) => {
          const deleted = payload.old as { id: string };
          if (!deleted?.id) return;

          setConversations((prev) => prev.filter((c) => c.id !== deleted.id));

          setCurrentConversation((prev) => {
            if (prev?.id === deleted.id) {
              clearStoredConversationId();
              return null;
            }
            return prev;
          });
          setCurrentParticipants([]);

          if (currentConversation?.id === deleted.id) {
            navigate('/dm', { replace: true });
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, currentConversation?.id, navigate]);

  // Realtime: add new conversations to sidebar when created
  useEffect(() => {
    if (!userId || !currentWorkspace) return;

    const channel = supabase
      .channel('dm-conversation-created-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'direct_conversations' },
        async (payload) => {
          const newConv = payload.new as {
            id: string;
            workspace_id: string;
            channel_id: string;
            type: string;
            name: string | null;
            avatar_url: string | null;
            created_by: string;
            created_at: string;
            updated_at: string;
          };
          if (!newConv?.id || newConv.workspace_id !== currentWorkspace.id) return;

          const enriched = await getConversationById(newConv.id);
          if (!enriched) return;
          const participants = await getConversationParticipants(newConv.id);

          setConversations((prev) => {
            if (prev.some((c) => c.id === newConv.id)) return prev;
            return [{ ...enriched, participants }, ...prev].sort(
              (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
            );
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, currentWorkspace?.id]);

  const refreshConversations = useCallback(async () => {
    await fetchConversations();
  }, [fetchConversations]);

  const clearCurrentConversation = useCallback(() => {
    setCurrentConversation(null);
    setCurrentParticipants([]);
    clearStoredConversationId();
  }, []);

  const value = useMemo<ConversationContextValue>(
    () => ({
      conversations,
      currentConversation,
      currentParticipants,
      isLoading,
      error,
      hasConversations,
      switchConversation,
      startDm,
      startGroup,
      refreshConversations,
      clearCurrentConversation,
      clearError,
    }),
    [
      conversations,
      currentConversation,
      currentParticipants,
      isLoading,
      error,
      hasConversations,
      switchConversation,
      startDm,
      startGroup,
      refreshConversations,
      clearCurrentConversation,
      clearError,
    ],
  );

  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

export function useConversationContext(): ConversationContextValue {
  const context = useContext(ConversationContext);
  if (!context) {
    throw new Error('useConversationContext must be used within a ConversationProvider');
  }
  return context;
}
