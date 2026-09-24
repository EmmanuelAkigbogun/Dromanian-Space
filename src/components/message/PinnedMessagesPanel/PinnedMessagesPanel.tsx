import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannel } from '@/hooks/useChannel';
import { useProfiles } from '@/hooks/useProfiles';
import { useAuth } from '@/hooks/useAuth';
import { getDisplayName, formatRelativeTime } from '@/lib/message';
import { getMessagesByIds } from '@/lib/message';
import { supabase } from '@/lib/supabase';
import { Avatar } from '@/components/ui/Avatar';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { MessageContent } from '@/components/message/MessageContent';
import styles from './PinnedMessagesPanel.module.css';
import type { PinnedMessage } from '@/types';

interface PinnedMessageWithContent extends PinnedMessage {
  content: string;
  user_id: string;
  channel_name?: string;
  channel_slug?: string;
}

interface PinnedMessagesPanelProps {
  channelId?: string;
  onClose?: () => void;
  showSearch?: boolean;
  showChannelNames?: boolean;
}

export function PinnedMessagesPanel({ channelId, onClose, showSearch = true, showChannelNames = true }: PinnedMessagesPanelProps) {
  const { currentChannel, channels } = useChannel();
  const { userId } = useAuth();
  const navigate = useNavigate();
  const [pinned, setPinned] = useState<PinnedMessageWithContent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const effectiveChannelId = channelId ?? currentChannel?.id;

  const uniqueUserIds = useMemo(
    () => [...new Set(pinned.map((p) => p.pinned_by))],
    [pinned],
  );
  const { profiles } = useProfiles(uniqueUserIds);

  const channelSlugsRef = useRef<Map<string, string>>(new Map());

  const fetchPinned = useCallback(async () => {
    setIsLoading(true);

    try {
      let query = supabase
        .from('pinned_messages')
        .select('*')
        .order('created_at', { ascending: false });

      if (effectiveChannelId) {
        query = query.eq('channel_id', effectiveChannelId);
      } else {
        const wsChannelIds = channels.map((c) => c.id);
        if (wsChannelIds.length > 0) {
          query = query.in('channel_id', wsChannelIds);
        }
      }

      const { data } = await query;

      if (!data || data.length === 0) {
        setPinned([]);
        return;
      }

      const slugMap = new Map<string, string>();
      const nameMap = new Map<string, string>();

      const messageIds = data.map((pin) => pin.message_id);
      const messagesById = new Map(
        (await getMessagesByIds(messageIds)).map((m) => [m.id, m]),
      );

      const channelIds = Array.from(
        new Set(
          data
            .map((pin) => messagesById.get(pin.message_id)?.channel_id)
            .filter((id): id is string => Boolean(id)),
        ),
      );
      if (channelIds.length > 0) {
        const { data: chs } = await supabase
          .from('channels')
          .select('id, name, slug')
          .in('id', channelIds);
        for (const ch of chs ?? []) {
          slugMap.set(ch.id, ch.slug);
          nameMap.set(ch.id, ch.name);
        }
      }

      const withContent = await Promise.all(
        data.map(async (pin) => {
          const msg = messagesById.get(pin.message_id);
          const cid = msg?.channel_id;
          return {
            ...pin,
            content: msg?.content ?? '[deleted]',
            user_id: msg?.user_id ?? pin.pinned_by,
            channel_name: cid ? nameMap.get(cid) : undefined,
            channel_slug: cid ? slugMap.get(cid) : undefined,
          };
        }),
      );
      channelSlugsRef.current = slugMap;

      setPinned(withContent);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [effectiveChannelId, channels]);

  useEffect(() => {
    fetchPinned();
  }, [fetchPinned]);

  useEffect(() => {
    const channel = supabase
      .channel('pinned-messages-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pinned_messages',
          filter: effectiveChannelId ? `channel_id=eq.${effectiveChannelId}` : undefined,
        },
        () => { fetchPinned(); },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchPinned, effectiveChannelId]);

  const handleUnpin = useCallback(async (pin: PinnedMessageWithContent) => {
    const { error } = await supabase
      .from('pinned_messages')
      .delete()
      .eq('channel_id', pin.channel_id)
      .eq('message_id', pin.message_id);

    if (!error) {
      setPinned((prev) => prev.filter((p) => p.message_id !== pin.message_id));
    }
  }, []);

  const handleJumpToMessage = useCallback(
    (pin: PinnedMessageWithContent) => {
      const slug = pin.channel_slug || channelSlugsRef.current.get(pin.channel_id) || currentChannel?.slug || pin.channel_id;
      if (pin.channel_id) {
        navigate(`/channels/${slug}#message-${pin.message_id}`);
      }
      onClose?.();
    },
    [navigate, onClose, currentChannel],
  );

  const filtered = searchQuery.trim()
    ? pinned.filter(
        (p) =>
          p.content?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.channel_name?.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : pinned;

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3 className={styles.title}>Pinned Messages</h3>
        <span className={styles.count}>{pinned.length}</span>
        {onClose && (
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close pinned messages"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
      {showSearch && (
        <div className={styles.searchWrapper}>
          <Input
            placeholder="Search pinned messages..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      )}
      <div className={styles.list} ref={scrollRef}>
        {filtered.length === 0 ? (
          <div className={styles.empty}>No pinned messages</div>
        ) : (
          filtered.map((pin) => {
            const profile = profiles.get(pin.pinned_by) ?? null;
            const displayName = getDisplayName(profile, pin.user_id);
            return (
              <div key={`${pin.channel_id}-${pin.message_id}`} className={styles.pinnedItem}>
                <button
                  type="button"
                  className={styles.pinnedItemButton}
                  onClick={() => handleJumpToMessage(pin)}
                >
                  <div className={styles.pinnedHeader}>
                    <Avatar
                      src={profile?.avatar_url || undefined}
                      name={displayName}
                      size="xs"
                    />
                    <span className={styles.pinnedAuthor}>{displayName}</span>
                    {showChannelNames && pin.channel_name && (
                      <span className={styles.pinnedChannel}>#{pin.channel_name}</span>
                    )}
                    <span className={styles.pinnedTime}>
                      {formatRelativeTime(pin.created_at)}
                    </span>
                  </div>
                  <div className={styles.pinnedContent}>
                    <MessageContent content={pin.content} />
                  </div>
                </button>
                <button
                  type="button"
                  className={styles.unpinButton}
                  onClick={() => handleUnpin(pin)}
                  title="Unpin"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
