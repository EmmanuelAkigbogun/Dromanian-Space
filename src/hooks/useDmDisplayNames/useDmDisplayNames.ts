import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { getDmChannelDisplayNames } from '@/lib/conversation/conversation';

const TTL_MS = 60 * 1000;

let shared: { key: string; promise: Promise<Record<string, string>>; expiresAt: number } | null = null;

export function useDmDisplayNames(): Record<string, string> {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!userId || !currentWorkspace) {
      setNames({});
      return;
    }
    let cancelled = false;
    const key = `${userId}|${currentWorkspace.id}`;
    if (shared?.key === key && shared.expiresAt > Date.now()) {
      shared.promise.then((map) => {
        if (!cancelled) setNames(map);
      });
    } else {
      const promise = getDmChannelDisplayNames(userId, currentWorkspace.id);
      shared = { key, promise, expiresAt: Date.now() + TTL_MS };
      promise.then((map) => {
        if (!cancelled) setNames(map);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [userId, currentWorkspace?.id]);

  return names;
}
