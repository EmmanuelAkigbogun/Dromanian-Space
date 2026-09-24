import { useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMessage } from '@/hooks/useMessage';
import { useChannel } from '@/hooks/useChannel';
import { useAuth } from '@/hooks/useAuth';
import { useProfiles } from '@/hooks/useProfiles';
import { useDeepLinkScroll } from '@/hooks/useDeepLinkScroll';
import { useThreadCounts } from '@/app/providers/ThreadProvider';
import { usePrefetchAttachments } from '@/hooks/useMessageAttachments';
import { MessageItem } from '@/components/message/MessageItem';
import { MessageInput } from '@/components/message/MessageInput';
import { MessageEmpty } from '@/components/message/MessageEmpty';
import { MessageLoading } from '@/components/message/MessageLoading';
import { DateSeparator } from '@/components/message/DateSeparator';
import { ConnectionIndicator } from '@/components/message/ConnectionIndicator';
import { MessageSelectionBanner } from '@/components/message/MessageSelectionBanner';
import { FailedMessageBanner } from '@/components/message/FailedMessageBanner';
import { shouldGroupWithPrevious, needsDateSeparator, getThreadMessageCounts } from '@/lib/message';
import type { Message } from '@/types';
import styles from './MessageList.module.css';

type VirtualItem =
  | { type: 'load-more'; id: string }
  | { type: 'error'; id: string; data: string }
  | { type: 'date-separator'; id: string; data: string }
  | { type: 'message'; id: string; data: { message: Message; isGrouped: boolean } };

export function MessageList() {
  const { messages, isLoading, isLoadingMore, hasMore, error, connectionStatus, failedMessages, loadMore, retryMessage, removeFailedMessage } = useMessage();
  const { currentChannel } = useChannel();
  const { userId } = useAuth();
  const parentRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevLenRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const restoreIndexRef = useRef<string | null>(null);

  const [highlightId, setHighlightId] = useState<string | null>(null);

  const messageIds = useMemo(() => messages.map((m) => m.id), [messages]);
  usePrefetchAttachments(messageIds);

  const uniqueUserIds = useMemo(
    () => [...new Set(messages.map((m) => m.user_id))],
    [messages],
  );
  const { profiles } = useProfiles(uniqueUserIds);

  const { setReplyCount } = useThreadCounts();

  useEffect(() => {
    if (messages.length === 0) return;
    const ids = messages.map((m) => m.id);
    getThreadMessageCounts(ids).then((counts) => {
      counts.forEach((count, parentId) => {
        if (count > 0) {
          setReplyCount(parentId, count);
        }
      });
    });
  }, [messages, setReplyCount]);

  const items = useMemo<VirtualItem[]>(() => {
    const list: VirtualItem[] = [];
    if (hasMore) list.push({ type: 'load-more', id: 'load-more' });
    if (error) list.push({ type: 'error', id: 'load-error', data: error });
    messages.forEach((message, index) => {
      const prev = index > 0 ? messages[index - 1] : undefined;
      if (needsDateSeparator(message, prev)) {
        list.push({ type: 'date-separator', id: `date-${message.created_at}`, data: message.created_at });
      }
      list.push({
        type: 'message',
        id: message.id,
        data: { message, isGrouped: shouldGroupWithPrevious(message, prev) },
      });
    });
    return list;
  }, [messages, hasMore, error]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const item = items[i];
      if (!item) return 110;
      if (item.type === 'date-separator') return 44;
      if (item.type === 'load-more') return 64;
      if (item.type === 'error') return 40;
      return 110;
    },
    overscan: 8,
  });

  function handleScroll() {
    const container = parentRef.current;
    if (!container) return;
    const threshold = 100;
    atBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }

  useEffect(() => {
    const container = parentRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const newMsgArrived = messages.length > prevLenRef.current;
    prevLenRef.current = messages.length;
    if (newMsgArrived && atBottomRef.current && messages.length > 0 && !loadingOlderRef.current) {
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
      });
    }
  }, [messages.length, items.length, virtualizer]);

  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const handleLoadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore) return;
    loadingOlderRef.current = true;
    const top = virtualizerRef.current.getVirtualItems()[0];
    const topId = top ? itemsRef.current[top.index]?.id ?? null : null;
    if (topId) restoreIndexRef.current = topId;
    await loadMore();
  }, [hasMore, isLoadingMore, loadMore]);

  useEffect(() => {
    if (!restoreIndexRef.current) return;
    const target = restoreIndexRef.current;
    const idx = items.findIndex((it) => it.id === target);
    restoreIndexRef.current = null;
    loadingOlderRef.current = false;
    if (idx !== -1) {
      virtualizer.scrollToIndex(idx, { align: 'start' });
    }
  }, [items, virtualizer]);

  const firstVirtualIndex = virtualizer.getVirtualItems()[0]?.index;

  useEffect(() => {
    if (!hasMore || isLoadingMore || !loadMoreRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          handleLoadMore();
        }
      },
      { root: parentRef.current, threshold: 0.1 },
    );
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, handleLoadMore, firstVirtualIndex]);

  const getItemIndex = useCallback(
    (messageId: string) => {
      const idx = items.findIndex(
        (it) => it.type === 'message' && (it.data as { message: Message }).message.id === messageId,
      );
      return idx === -1 ? null : idx;
    },
    [items],
  );

  const scrollToMessage = useCallback(
    (index: number) => {
      virtualizer.scrollToIndex(index, { align: 'center' });
    },
    [virtualizer],
  );

  useDeepLinkScroll({ getItemIndex, scrollToIndex: scrollToMessage, onHighlight: setHighlightId });

  if (isLoading) {
    return <MessageLoading />;
  }

  if (messages.length === 0) {
    return (
      <div className={styles.container}>
        <ConnectionIndicator status={connectionStatus} />
        <MessageEmpty channelName={currentChannel?.name} />
        <MessageSelectionBanner />
        {failedMessages.map((fm) => (
          <FailedMessageBanner
            key={fm.tempId}
            content={fm.content}
            tempId={fm.tempId}
            onRetry={retryMessage}
            onRemove={removeFailedMessage}
          />
        ))}
        <MessageInput />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <ConnectionIndicator status={connectionStatus} />
      <MessageSelectionBanner />
      <div className={styles.messageArea} ref={parentRef}>
        <div className={styles.messageList} style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const item = items[vi.index];
            return (
              <div
                key={item.id}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className={styles.virtualRow}
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                {item.type === 'load-more' && (
                  <div ref={loadMoreRef} className={styles.loadMore}>
                    <button
                      type="button"
                      className={styles.loadMoreButton}
                      onClick={handleLoadMore}
                      disabled={isLoadingMore}
                    >
                      {isLoadingMore ? 'Loading...' : 'Load older messages'}
                    </button>
                  </div>
                )}
                {item.type === 'error' && <div className={styles.error}>{item.data}</div>}
                {item.type === 'date-separator' && <DateSeparator date={item.data} />}
                {item.type === 'message' && (() => {
                  const data = item.data as { message: Message; isGrouped: boolean };
                  return (
                    <MessageItem
                      message={data.message}
                      isOwn={data.message.user_id === userId}
                      profile={profiles.get(data.message.user_id) ?? null}
                      isGrouped={data.isGrouped}
                      highlight={highlightId === data.message.id}
                    />
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>

      {failedMessages.map((fm) => (
        <FailedMessageBanner
          key={fm.tempId}
          content={fm.content}
          tempId={fm.tempId}
          onRetry={retryMessage}
          onRemove={removeFailedMessage}
        />
      ))}

      <MessageInput />
    </div>
  );
}
