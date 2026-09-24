import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import {
  getWorkspaceChannels,
  getChannelBySlug,
  getChannelMemberCounts,
  createChannel as createChannelService,
  updateChannel as updateChannelService,
  archiveChannel as archiveChannelService,
  restoreChannel as restoreChannelService,
  deleteChannel as deleteChannelService,
  joinChannel as joinChannelService,
  leaveChannel as leaveChannelService,
} from '@/lib/channel';
import type { Channel } from '@/types';

interface ChannelContextValue {
  channels: Channel[];
  currentChannel: Channel | null;
  memberChannelIds: Set<string>;
  memberCounts: Record<string, number>;
  isLoading: boolean;
  error: string | null;
  hasChannels: boolean;
  switchChannel: (slug: string) => Promise<void>;
  createChannel: (
    name: string,
    slug: string,
    options?: { description?: string; topic?: string; type?: Channel['type']; isPrivate?: boolean },
  ) => Promise<Channel | null>;
  updateChannel: (
    channelId: string,
    updates: Partial<Pick<Channel, 'name' | 'description' | 'topic' | 'type' | 'is_private'>>,
  ) => Promise<void>;
  archiveChannel: (channelId: string) => Promise<void>;
  restoreChannel: (channelId: string) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  joinChannel: (channelId: string) => Promise<boolean>;
  leaveChannel: (channelId: string) => Promise<boolean>;
  refreshChannels: () => Promise<void>;
  clearError: () => void;
}

const ChannelContext = createContext<ChannelContextValue | null>(null);

const STORAGE_KEY = 'dark-space-channel';

function getStoredSlug(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeSlug(slug: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, slug);
  } catch {
    // localStorage not available
  }
}

function clearStoredSlug(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage not available
  }
}

async function getChannelMemberIdsForWorkspace(
  workspaceId: string,
  userId: string,
): Promise<Set<string>> {
  const { supabase } = await import('@/lib/supabase');
  const { data, error } = await supabase
    .from('channel_members')
    .select('channel_id')
    .eq('user_id', userId)
    .in(
      'channel_id',
      (
        await supabase
          .from('channels')
          .select('id')
          .eq('workspace_id', workspaceId)
          .is('archived_at', null)
      ).data?.map((c) => c.id) ?? [],
    );

  if (error || !data) return new Set();
  return new Set(data.map((row) => row.channel_id));
}

interface ChannelProviderProps {
  children: ReactNode;
}

export function ChannelProvider({ children }: ChannelProviderProps) {
  const { currentWorkspace } = useWorkspace();
  const { userId } = useAuth();
  const navigate = useNavigate();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
  const [memberChannelIds, setMemberChannelIds] = useState<Set<string>>(new Set());
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hasChannels = channels.length > 0;

  const clearError = useCallback(() => setError(null), []);

  const fetchChannels = useCallback(async () => {
    if (!currentWorkspace) {
      setChannels([]);
      setCurrentChannel(null);
      setMemberChannelIds(new Set());
      setMemberCounts({});
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const [workspaceChannels, memberIds] = await Promise.all([
        getWorkspaceChannels(currentWorkspace.id),
        userId ? getChannelMemberIdsForWorkspace(currentWorkspace.id, userId) : Promise.resolve(new Set<string>()),
      ]);

      setChannels(workspaceChannels);
      setMemberChannelIds(memberIds);

      const counts = await getChannelMemberCounts(workspaceChannels.map((c) => c.id));
      setMemberCounts(counts);

      if (workspaceChannels.length === 0) {
        setCurrentChannel(null);
        clearStoredSlug();
        setIsLoading(false);
        return;
      }

      const storedSlug = getStoredSlug();
      let selectedChannel: Channel | undefined;

      if (storedSlug) {
        selectedChannel = workspaceChannels.find((c) => c.slug === storedSlug);
      }

      if (!selectedChannel) {
        selectedChannel = workspaceChannels[0];
      }

      setCurrentChannel(selectedChannel);
      storeSlug(selectedChannel.slug);
    } catch (err) {
      setError('Failed to load channels');
      setCurrentChannel(null);
    } finally {
      setIsLoading(false);
    }
  }, [currentWorkspace, userId]);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  // Realtime: add new channels to sidebar when created by anyone
  useEffect(() => {
    if (!currentWorkspace) return;

    const channel = supabase
      .channel('channel-created-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'channels', filter: `workspace_id=eq.${currentWorkspace.id}` },
        (payload) => {
          const newChannel = payload.new as Channel;
          if (!newChannel?.id || newChannel.workspace_id !== currentWorkspace.id) return;
          if (newChannel.archived_at) return;

          setChannels((prev) => {
            if (prev.some((c) => c.id === newChannel.id)) return prev;
            return [...prev, newChannel];
          });
          setMemberCounts((prev) => ({ ...prev, [newChannel.id]: 1 }));

          if (userId && newChannel.created_by === userId) {
            setMemberChannelIds((prev) => new Set(prev).add(newChannel.id));
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentWorkspace?.id, userId]);

  // Realtime: remove channels from sidebar when deleted
  useEffect(() => {
    if (!currentWorkspace) return;

    const channel = supabase
      .channel('channel-deleted-realtime')
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'channels' },
        (payload) => {
          const deleted = payload.old as { id: string };
          if (!deleted?.id) return;

          setChannels((prev) => prev.filter((c) => c.id !== deleted.id));
          setMemberChannelIds((prev) => {
            const next = new Set(prev);
            next.delete(deleted.id);
            return next;
          });

          setCurrentChannel((prev) => {
            if (prev?.id === deleted.id) {
              clearStoredSlug();
              return null;
            }
            return prev;
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentWorkspace?.id]);

  const switchChannel = useCallback(
    async (slug: string) => {
      if (!currentWorkspace) return;
      setError(null);
      const channel = await getChannelBySlug(currentWorkspace.id, slug);
      if (!channel) {
        setError('Channel not found');
        return;
      }
      setChannels((prev) => prev.map((c) => (c.id === channel.id ? channel : c)));
      setCurrentChannel(channel);
      storeSlug(slug);
    },
    [currentWorkspace],
  );

  const createChannel = useCallback(
    async (
      name: string,
      slug: string,
      options?: { description?: string; topic?: string; type?: Channel['type']; isPrivate?: boolean },
    ): Promise<Channel | null> => {
      if (!currentWorkspace || !userId) return null;

      setError(null);
      const channel = await createChannelService(currentWorkspace.id, name, slug, userId, options);
      if (!channel) {
        setError('Failed to create channel');
        return null;
      }

      setChannels((prev) => (prev.some((c) => c.id === channel.id) ? prev : [...prev, channel]));
      setCurrentChannel(channel);
      setMemberCounts((prev) => ({ ...prev, [channel.id]: 1 }));
      setMemberChannelIds((prev) => new Set(prev).add(channel.id));
      storeSlug(channel.slug);
      return channel;
    },
    [currentWorkspace, userId],
  );

  const updateChannelHandler = useCallback(
    async (
      channelId: string,
      updates: Partial<Pick<Channel, 'name' | 'description' | 'topic' | 'type' | 'is_private'>>,
    ) => {
      setError(null);
      const updated = await updateChannelService(channelId, updates);
      if (!updated) {
        setError('Failed to update channel');
        return;
      }

      setChannels((prev) => prev.map((c) => (c.id === channelId ? updated : c)));
      if (currentChannel?.id === channelId) {
        setCurrentChannel(updated);
      }
    },
    [currentChannel],
  );

  const archiveChannelHandler = useCallback(
    async (channelId: string) => {
      setError(null);
      const archived = await archiveChannelService(channelId);
      if (!archived) {
        setError('Failed to archive channel');
        return;
      }

      let remaining: Channel[] = [];
      setChannels((prev) => {
        remaining = prev.filter((c) => c.id !== channelId);
        return remaining;
      });

      if (currentChannel?.id === channelId) {
        if (remaining.length > 0) {
          setCurrentChannel(remaining[0]);
          storeSlug(remaining[0].slug);
        } else {
          setCurrentChannel(null);
          clearStoredSlug();
        }
      }
    },
    [currentChannel],
  );

  const restoreChannelHandler = useCallback(
    async (channelId: string) => {
      setError(null);
      const restored = await restoreChannelService(channelId);
      if (!restored) {
        setError('Failed to restore channel');
        return;
      }
      setChannels((prev) => (prev.some((c) => c.id === channelId) ? prev : [...prev, restored]));
    },
    [],
  );

  const deleteChannelHandler = useCallback(
    async (channelId: string) => {
      setError(null);
      const success = await deleteChannelService(channelId);
      if (!success) {
        setError('Failed to delete channel');
        return;
      }

      let remaining: Channel[] = [];
      setChannels((prev) => {
        remaining = prev.filter((c) => c.id !== channelId);
        return remaining;
      });
      setMemberChannelIds((prev) => {
        const next = new Set(prev);
        next.delete(channelId);
        return next;
      });

      if (currentChannel?.id === channelId) {
        if (remaining.length > 0) {
          setCurrentChannel(remaining[0]);
          storeSlug(remaining[0].slug);
          navigate(`/channels/${remaining[0].slug}`);
        } else {
          setCurrentChannel(null);
          clearStoredSlug();
          navigate('/channels');
        }
      }
    },
    [currentChannel],
  );

  const joinChannelHandler = useCallback(
    async (channelId: string): Promise<boolean> => {
      if (!userId) return false;
      setError(null);
      const member = await joinChannelService(channelId, userId);
      if (!member) {
        setError('Failed to join channel');
        return false;
      }
      setMemberChannelIds((prev) => new Set(prev).add(channelId));
      return true;
    },
    [userId],
  );

  const leaveChannelHandler = useCallback(
    async (channelId: string): Promise<boolean> => {
      if (!userId) return false;
      setError(null);
      const success = await leaveChannelService(channelId, userId);
      if (!success) {
        setError('Failed to leave channel');
        return false;
      }
      setMemberChannelIds((prev) => {
        const next = new Set(prev);
        next.delete(channelId);
        return next;
      });

      if (currentChannel?.id === channelId) {
        let remaining: Channel[] = [];
        setChannels((prev) => {
          remaining = prev.filter((c) => c.id !== channelId && !c.archived_at);
          return remaining;
        });
        if (remaining.length > 0) {
          setCurrentChannel(remaining[0]);
          storeSlug(remaining[0].slug);
        } else {
          setCurrentChannel(null);
          clearStoredSlug();
        }
      }

      return true;
    },
    [userId, currentChannel],
  );

  const refreshChannels = useCallback(async () => {
    await fetchChannels();
  }, [fetchChannels]);

  const value = useMemo<ChannelContextValue>(
    () => ({
      channels,
      currentChannel,
      memberChannelIds,
      memberCounts,
      isLoading,
      error,
      hasChannels,
      switchChannel,
      createChannel,
      updateChannel: updateChannelHandler,
      archiveChannel: archiveChannelHandler,
      restoreChannel: restoreChannelHandler,
      deleteChannel: deleteChannelHandler,
      joinChannel: joinChannelHandler,
      leaveChannel: leaveChannelHandler,
      refreshChannels,
      clearError,
    }),
    [
      channels,
      currentChannel,
      memberChannelIds,
      memberCounts,
      isLoading,
      error,
      hasChannels,
      switchChannel,
      createChannel,
      updateChannelHandler,
      archiveChannelHandler,
      restoreChannelHandler,
      deleteChannelHandler,
      joinChannelHandler,
      leaveChannelHandler,
      refreshChannels,
      clearError,
    ],
  );

  return <ChannelContext.Provider value={value}>{children}</ChannelContext.Provider>;
}

export function useChannelContext(): ChannelContextValue {
  const context = useContext(ChannelContext);
  if (!context) {
    throw new Error('useChannelContext must be used within a ChannelProvider');
  }
  return context;
}

export function useChannelContextSafe(): ChannelContextValue | null {
  return useContext(ChannelContext);
}
