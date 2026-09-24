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
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';

export type PresenceStatus = 'online' | 'away' | 'busy' | 'invisible' | 'offline';

export interface PresenceState {
  user_id: string;
  status: PresenceStatus;
  last_active_at: string;
  device_id: string;
}

interface PresenceContextValue {
  presenceMap: Map<string, PresenceState>;
  myStatus: PresenceStatus;
  setMyStatus: (status: PresenceStatus | null) => void;
  isOnline: (userId: string) => boolean;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

function getDeviceId(): string {
  try {
    const key = 'dark-space-device-id';
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

interface PresenceProviderProps {
  children: ReactNode;
}

export function PresenceProvider({ children }: PresenceProviderProps) {
  const { userId, isAuthenticated } = useAuth();
  const { currentWorkspace } = useWorkspaceContext();
  const workspaceId = currentWorkspace?.id ?? null;

  const [presenceMap, setPresenceMap] = useState<Map<string, PresenceState>>(new Map());
  const [myStatus, setMyStatusState] = useState<PresenceStatus>('online');
  const manualStatusRef = useRef<PresenceStatus | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deviceIdRef = useRef(getDeviceId());

  const trackPresence = useCallback(
    async (status: PresenceStatus) => {
      const channel = channelRef.current;
      if (!channel || !userId) return;

      try {
        await channel.track({
          user_id: userId,
          status,
          last_active_at: new Date().toISOString(),
          device_id: deviceIdRef.current,
        });
      } catch (err) {
        console.warn('Failed to track presence:', err);
      }
    },
    [userId],
  );

  const handleVisibilityChange = useCallback(() => {
    if (manualStatusRef.current) return;

    if (document.hidden) {
      setMyStatusState('away');
      trackPresence('away');
    } else {
      lastActivityRef.current = Date.now();
      setMyStatusState('online');
      trackPresence('online');
    }
  }, [trackPresence]);

  const handleActivity = useCallback(() => {
    if (manualStatusRef.current) return;
    if (document.hidden) return;

    lastActivityRef.current = Date.now();

    if (myStatus !== 'online') {
      setMyStatusState('online');
      trackPresence('online');
    }
  }, [myStatus, trackPresence]);

  const setMyStatus = useCallback(
    (status: PresenceStatus | null) => {
      manualStatusRef.current = status;
      const resolved = status ?? 'online';
      setMyStatusState(resolved);
      trackPresence(resolved);
    },
    [trackPresence],
  );

  // Set up channel and listeners when workspace/user changes
  useEffect(() => {
    if (!workspaceId || !userId || !isAuthenticated) {
      return;
    }

    const channel = supabase.channel(`workspace:${workspaceId}:presence`);
    channelRef.current = channel;

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState() as Record<string, Array<PresenceState>>;
        const next = new Map<string, PresenceState>();

        for (const _key in state) {
          const presences = state[_key];
          if (presences.length > 0) {
            const latest = presences.reduce((a, b) =>
              new Date(a.last_active_at) >= new Date(b.last_active_at) ? a : b,
            );
            next.set(latest.user_id, latest);
          }
        }

        setPresenceMap(next);
      })
      .on('presence', { event: 'join' }, () => {})
      .on('presence', { event: 'leave' }, () => {})
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await trackPresence(myStatus);
        }
      });

    return () => {
      channel.unsubscribe();
      channelRef.current = null;
    };
  }, [workspaceId, userId, isAuthenticated]);

  // Heartbeat
  useEffect(() => {
    if (!userId) return;

    heartbeatRef.current = setInterval(async () => {
      try {
        await supabase.rpc('touch_presence');
      } catch {
        // Silently fail heartbeat
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [userId]);

  // Auto-persist the user's timezone so other members can see their local time
  useEffect(() => {
    if (!userId || !isAuthenticated) return;

    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!detected) return;

    let cancelled = false;
    supabase
      .from('profiles')
      .select('timezone')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (data && data.timezone === detected) return;
        return supabase.from('profiles').update({ timezone: detected }).eq('id', userId);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, isAuthenticated]);

  // Idle detection
  useEffect(() => {
    const events = ['mousedown', 'keydown', 'mousemove', 'scroll', 'touchstart'];

    events.forEach((event) => document.addEventListener(event, handleActivity, { passive: true }));
    document.addEventListener('visibilitychange', handleVisibilityChange);

    idleCheckRef.current = setInterval(() => {
      if (manualStatusRef.current) return;
      if (document.hidden) return;

      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed >= IDLE_TIMEOUT_MS && myStatus !== 'away') {
        setMyStatusState('away');
        trackPresence('away');
      }
    }, 60_000);

    return () => {
      events.forEach((event) => document.removeEventListener(event, handleActivity));
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (idleCheckRef.current) {
        clearInterval(idleCheckRef.current);
        idleCheckRef.current = null;
      }
    };
  }, [handleActivity, handleVisibilityChange, myStatus, trackPresence]);

  // Set offline on logout
  useEffect(() => {
    if (!isAuthenticated || !userId) return;

    const handleUnload = async () => {
      manualStatusRef.current = null;
      try {
        await supabase.rpc('set_user_offline');
      } catch {
        // Best effort
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      handleUnload();
    };
  }, [isAuthenticated, userId]);

  const isOnline = useCallback(
    (targetUserId: string): boolean => {
      const state = presenceMap.get(targetUserId);
      return state?.status === 'online';
    },
    [presenceMap],
  );

  const value = useMemo<PresenceContextValue>(
    () => ({
      presenceMap,
      myStatus,
      setMyStatus,
      isOnline,
    }),
    [presenceMap, myStatus, setMyStatus, isOnline],
  );

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

export function usePresenceContext(): PresenceContextValue {
  const context = useContext(PresenceContext);
  if (!context) {
    throw new Error('usePresenceContext must be used within a PresenceProvider');
  }
  return context;
}
