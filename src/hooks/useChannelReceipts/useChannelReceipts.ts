import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { platform } from '@/lib/platform';
import { useAuth } from '@/hooks/useAuth';
import type { Message } from '@/types';

export type ReceiptStatus = 'sent' | 'delivered' | 'read';

interface MemberReceipt {
  user_id: string;
  last_delivered_at: string | null;
  last_read_at: string | null;
}

export interface Receipt {
  status: ReceiptStatus;
  /** Members (other than the sender) who have read the message. */
  readBy: string[];
  /** Members other than the sender. */
  others: number;
}

const after = (at: string | null, created: string) => !!at && new Date(at) >= new Date(created);

/**
 * Delivered and read receipts for a conversation. While the conversation is
 * on screen it is marked read up to its newest message; each of the caller's
 * own messages is delivered/read once every other member is past it. Other
 * members' progress arrives live.
 */
export function useChannelReceipts(channelId: string | undefined, messages: Message[]) {
  const { userId } = useAuth();
  const [members, setMembers] = useState<Map<string, MemberReceipt>>(new Map());
  const markedRef = useRef<string>('');

  useEffect(() => {
    setMembers(new Map());
    markedRef.current = '';
    if (!channelId) return;
    let cancelled = false;
    platform.rpc<MemberReceipt[]>('channel_receipts', { p_channel_id: channelId }).then(({ data }) => {
      if (!cancelled) setMembers(new Map((data ?? []).map((m) => [m.user_id, m])));
    });
    const live = platform
      .channel(`receipts:${channelId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'channel_members', filter: `channel_id=eq.${channelId}` }, (payload) => {
        const row = payload.new as MemberReceipt;
        if (row?.user_id) setMembers((prev) => new Map(prev).set(row.user_id, row));
      })
      .subscribe();
    return () => {
      cancelled = true;
      live.unsubscribe();
    };
  }, [channelId]);

  // Mark read up to the newest message from someone else while visible.
  const newest = useMemo(() => {
    let at = '';
    for (const m of messages) if (m.user_id !== userId && !m.id.startsWith('temp') && m.created_at > at) at = m.created_at;
    return at;
  }, [messages, userId]);

  useEffect(() => {
    if (!channelId || !newest) return;
    const mark = () => {
      if (document.visibilityState !== 'visible' || markedRef.current >= newest) return;
      markedRef.current = newest;
      void platform.rpc('mark_channel_seen', { p_channel_id: channelId, p_up_to: newest, p_read: true });
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    window.addEventListener('focus', mark);
    return () => {
      document.removeEventListener('visibilitychange', mark);
      window.removeEventListener('focus', mark);
    };
  }, [channelId, newest]);

  const receiptFor = useCallback(
    (message: Message): Receipt | null => {
      if (message.user_id !== userId || message.agent_id) return null;
      const others = [...members.values()].filter((m) => m.user_id !== userId);
      if (!others.length) return null;
      const readBy = others.filter((m) => after(m.last_read_at, message.created_at)).map((m) => m.user_id);
      const status: ReceiptStatus =
        readBy.length === others.length ? 'read' : others.every((m) => after(m.last_delivered_at, message.created_at)) ? 'delivered' : 'sent';
      return { status, readBy, others: others.length };
    },
    [members, userId],
  );

  // "Seen by" is shown once, under the caller's latest message.
  const lastOwnId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].user_id === userId && !messages[i].agent_id) return messages[i].id;
    return null;
  }, [messages, userId]);

  return { receiptFor, lastOwnId };
}

/**
 * While the app runs, everything sent to this person counts as delivered:
 * on start, when it comes back to the foreground, and as messages arrive.
 */
export function useDeliveryTracker() {
  const { userId } = useAuth();
  useEffect(() => {
    if (!userId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const mark = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void platform.rpc('mark_all_delivered');
      }, 1500);
    };
    mark();
    const onVisible = () => document.visibilityState === 'visible' && mark();
    document.addEventListener('visibilitychange', onVisible);
    const live = platform
      .channel(`delivery:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        if ((payload.new as Message)?.user_id !== userId) mark();
      })
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      live.unsubscribe();
    };
  }, [userId]);
}

/** "Seen by Ana, Bob and 2 others" for group conversations; nothing for one-to-one. */
export function seenByLabel(receipt: Receipt | null, nameOf: (userId: string) => string | undefined): string | undefined {
  if (!receipt || receipt.others < 2 || !receipt.readBy.length) return undefined;
  if (receipt.readBy.length === receipt.others) return 'Seen by everyone';
  const names = receipt.readBy.map(nameOf).filter((n): n is string => !!n);
  const shown = names.slice(0, 3);
  const rest = receipt.readBy.length - shown.length;
  if (!shown.length) return `Seen by ${rest}`;
  return `Seen by ${shown.join(', ')}${rest ? ` and ${rest} other${rest === 1 ? '' : 's'}` : ''}`;
}
