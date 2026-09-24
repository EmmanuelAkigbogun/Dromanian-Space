import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { UUID } from '@/types';

export interface TypingUser {
  name: string;
  timestamp: number;
}

interface UseTypingIndicatorReturn {
  typingUsers: Map<string, TypingUser>;
  startTyping: () => void;
  stopTyping: () => void;
}

const THROTTLE_MS = 3000;
const CLEAR_TIMEOUT_MS = 5000;

export function useTypingIndicator(
  channelId: UUID,
  channelType: 'channel' | 'conversation',
): UseTypingIndicatorReturn {
  const { userId } = useAuth();
  const [typingUsers, setTypingUsers] = useState<Map<string, TypingUser>>(new Map());
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const lastSentRef = useRef<number>(0);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  useEffect(() => {
    if (!channelId || !userId) return;

    const channelName = `${channelType}:${channelId}:typing`;
    const channel = supabase.channel(channelName);
    channelRef.current = channel;

    channel
      .on('broadcast', { event: 'typing_start' }, (payload) => {
        const { user_id, user_name } = payload.payload as {
          user_id: string;
          user_name: string;
        };

        if (user_id === userId) return;

        setTypingUsers((prev) => {
          const next = new Map(prev);
          next.set(user_id, { name: user_name, timestamp: Date.now() });
          return next;
        });
      })
      .on('broadcast', { event: 'typing_stop' }, (payload) => {
        const { user_id } = payload.payload as { user_id: string };
        setTypingUsers((prev) => {
          const next = new Map(prev);
          next.delete(user_id);
          return next;
        });
      })
      .subscribe();

    return () => {
      channel.unsubscribe();
      channelRef.current = null;
    };
  }, [channelId, channelType, userId]);

  // Auto-clear stale typing indicators
  useEffect(() => {
    if (typingUsers.size === 0) return;

    const interval = setInterval(() => {
      const now = Date.now();
      setTypingUsers((prev) => {
        const next = new Map(prev);
        let changed = false;
        for (const [id, user] of next) {
          if (now - user.timestamp > CLEAR_TIMEOUT_MS) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [typingUsers.size]);

  const startTyping = useCallback(() => {
    const channel = channelRef.current;
    if (!channel || !userId || isTypingRef.current) return;

    const now = Date.now();
    if (now - lastSentRef.current < THROTTLE_MS) return;

    lastSentRef.current = now;
    isTypingRef.current = true;

    channel.send({
      type: 'broadcast',
      event: 'typing_start',
      payload: { user_id: userId, user_name: '' },
    });

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false;
    }, THROTTLE_MS);
  }, [userId]);

  const stopTyping = useCallback(() => {
    const channel = channelRef.current;
    if (!channel || !userId) return;

    isTypingRef.current = false;
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    channel.send({
      type: 'broadcast',
      event: 'typing_stop',
      payload: { user_id: userId },
    });
  }, [userId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      stopTyping();
    };
  }, [stopTyping]);

  return { typingUsers, startTyping, stopTyping };
}
