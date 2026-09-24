import { useCallback, useMemo } from 'react';
import { usePresenceContext, type PresenceStatus, type PresenceState } from '@/app/providers/PresenceProvider';
import { formatRelativeTime } from '@/utils';

interface UsePresenceReturn {
  presenceMap: Map<string, PresenceState>;
  myStatus: PresenceStatus;
  setMyStatus: (status: PresenceStatus | null) => void;
  getUserPresence: (userId: string) => PresenceState | undefined;
  isOnline: (userId: string) => boolean;
  getRelativeLastSeen: (userId: string) => string;
}

export function usePresence(): UsePresenceReturn {
  const { presenceMap, myStatus, setMyStatus, isOnline } = usePresenceContext();

  const getUserPresence = useCallback(
    (userId: string): PresenceState | undefined => {
      return presenceMap.get(userId);
    },
    [presenceMap],
  );

  const getRelativeLastSeen = useCallback(
    (userId: string): string => {
      const presence = presenceMap.get(userId);
      if (!presence) return 'Unknown';
      if (presence.status === 'online') return 'Online now';
      return `Last seen ${formatRelativeTime(presence.last_active_at)}`;
    },
    [presenceMap],
  );

  return useMemo(
    () => ({
      presenceMap,
      myStatus,
      setMyStatus,
      getUserPresence,
      isOnline,
      getRelativeLastSeen,
    }),
    [presenceMap, myStatus, setMyStatus, getUserPresence, isOnline, getRelativeLastSeen],
  );
}
