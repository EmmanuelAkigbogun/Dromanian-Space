import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { UUID } from '@/types';

export type ReceiptStatus = 'sent' | 'delivered' | 'read';

interface ReadReceiptData {
  message_id: string;
  user_id: string;
  read_at: string;
}

interface UseReadReceiptsReturn {
  getReceiptStatus: (messageId: UUID) => ReceiptStatus;
  getReadCount: (messageId: UUID) => number;
  markAsRead: (messageId: UUID) => Promise<void>;
  markChannelRead: (channelId: UUID, upToMessageId: UUID) => Promise<void>;
}

export function useReadReceipts(channelId?: UUID): UseReadReceiptsReturn {
  const { userId } = useAuth();
  const [receipts, setReceipts] = useState<Map<string, ReadReceiptData[]>>(new Map());
  const processedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!channelId) return;

    let mounted = true;

    const fetchReceipts = async () => {
      try {
        const { data, error } = await supabase
          .from('message_read_receipts')
          .select('message_id, user_id, read_at')
          .eq('channel_id', channelId);

        if (error || !mounted) return;

        const next = new Map<string, ReadReceiptData[]>();
        for (const row of (data as unknown as ReadReceiptData[]) ?? []) {
          const existing = next.get(row.message_id) ?? [];
          existing.push(row);
          next.set(row.message_id, existing);
        }
        setReceipts(next);
      } catch {
        // Silently fail initial fetch
      }
    };

    fetchReceipts();

    const channel = supabase
      .channel(`channel:${channelId}:receipts`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'message_read_receipts',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          if (!mounted) return;
          const row = payload.new as ReadReceiptData;
          setReceipts((prev) => {
            const next = new Map(prev);
            const existing = next.get(row.message_id) ?? [];
            if (!existing.some((r) => r.user_id === row.user_id)) {
              next.set(row.message_id, [...existing, row]);
            }
            return next;
          });
        },
      )
      .subscribe();

    return () => {
      mounted = false;
      channel.unsubscribe();
    };
  }, [channelId]);

  const getReceiptStatus = useCallback(
    (messageId: UUID): ReceiptStatus => {
      const messageReceipts = receipts.get(messageId);
      if (!messageReceipts || messageReceipts.length === 0) return 'sent';
      if (messageReceipts.some((r) => r.user_id !== userId)) return 'read';
      return 'delivered';
    },
    [receipts, userId],
  );

  const getReadCount = useCallback(
    (messageId: UUID): number => {
      const messageReceipts = receipts.get(messageId);
      if (!messageReceipts) return 0;
      return messageReceipts.filter((r) => r.user_id !== userId).length;
    },
    [receipts, userId],
  );

  const markAsRead = useCallback(
    async (messageId: UUID) => {
      if (!userId || processedRef.current.has(messageId)) return;
      processedRef.current.add(messageId);

      try {
        await supabase.from('message_read_receipts').upsert(
          {
            message_id: messageId,
            user_id: userId,
            read_at: new Date().toISOString(),
          } as any,
          { onConflict: 'message_id,user_id' },
        );
      } catch {
        processedRef.current.delete(messageId);
      }
    },
    [userId],
  );

  const markChannelRead = useCallback(
    async (targetChannelId: UUID, upToMessageId: UUID) => {
      if (!userId) return;

      try {
        await supabase.rpc('mark_channel_read_up_to' as any, {
          p_channel_id: targetChannelId,
          p_message_id: upToMessageId,
        });
      } catch {
        // Best effort
      }
    },
    [userId],
  );

  return { getReceiptStatus, getReadCount, markAsRead, markChannelRead };
}
