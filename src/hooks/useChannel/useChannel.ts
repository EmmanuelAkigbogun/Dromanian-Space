import { useMemo } from 'react';
import { useChannelContext, useChannelContextSafe } from '@/app/providers/ChannelProvider';
import type { Channel } from '@/types';

interface UseChannelReturn {
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
  isMember: (channelId: string) => boolean;
  refreshChannels: () => Promise<void>;
  clearError: () => void;
}

export function useChannel(): UseChannelReturn {
  const ctx = useChannelContext();

  const isMember = useMemo(
    () => (channelId: string) => ctx.memberChannelIds.has(channelId),
    [ctx.memberChannelIds],
  );

  return useMemo(
    () => ({
      channels: ctx.channels,
      currentChannel: ctx.currentChannel,
      memberChannelIds: ctx.memberChannelIds,
      memberCounts: ctx.memberCounts,
      isLoading: ctx.isLoading,
      error: ctx.error,
      hasChannels: ctx.hasChannels,
      switchChannel: ctx.switchChannel,
      createChannel: ctx.createChannel,
      updateChannel: ctx.updateChannel,
      archiveChannel: ctx.archiveChannel,
      restoreChannel: ctx.restoreChannel,
      deleteChannel: ctx.deleteChannel,
      joinChannel: ctx.joinChannel,
      leaveChannel: ctx.leaveChannel,
      isMember,
      refreshChannels: ctx.refreshChannels,
      clearError: ctx.clearError,
    }),
    [
      ctx.channels,
      ctx.currentChannel,
      ctx.memberChannelIds,
      ctx.memberCounts,
      ctx.isLoading,
      ctx.error,
      ctx.hasChannels,
      ctx.switchChannel,
      ctx.createChannel,
      ctx.updateChannel,
      ctx.archiveChannel,
      ctx.restoreChannel,
      ctx.deleteChannel,
      ctx.joinChannel,
      ctx.leaveChannel,
      ctx.refreshChannels,
      ctx.clearError,
      isMember,
    ],
  );
}

const nullChannelReturn: UseChannelReturn = {
  channels: [],
  currentChannel: null,
  memberChannelIds: new Set(),
  memberCounts: {},
  isLoading: false,
  error: null,
  hasChannels: false,
  switchChannel: async () => {},
  createChannel: async () => null,
  updateChannel: async () => {},
  archiveChannel: async () => {},
  restoreChannel: async () => {},
  deleteChannel: async () => {},
  joinChannel: async () => false,
  leaveChannel: async () => false,
  isMember: () => false,
  refreshChannels: async () => {},
  clearError: () => {},
};

export function useChannelSafe(): UseChannelReturn {
  const ctx = useChannelContextSafe();

  return useMemo(() => {
    if (!ctx) return nullChannelReturn;

    const isMember = (channelId: string) => ctx.memberChannelIds.has(channelId);

    return {
      channels: ctx.channels,
      currentChannel: ctx.currentChannel,
      memberChannelIds: ctx.memberChannelIds,
      memberCounts: ctx.memberCounts,
      isLoading: ctx.isLoading,
      error: ctx.error,
      hasChannels: ctx.hasChannels,
      switchChannel: ctx.switchChannel,
      createChannel: ctx.createChannel,
      updateChannel: ctx.updateChannel,
      archiveChannel: ctx.archiveChannel,
      restoreChannel: ctx.restoreChannel,
      deleteChannel: ctx.deleteChannel,
      joinChannel: ctx.joinChannel,
      leaveChannel: ctx.leaveChannel,
      isMember,
      refreshChannels: ctx.refreshChannels,
      clearError: ctx.clearError,
    };
  }, [ctx]);
}
