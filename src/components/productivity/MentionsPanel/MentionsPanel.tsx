import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMentions } from '@/hooks/useMentions';
import { Avatar } from '@/components/ui/Avatar';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { Spinner } from '@/components/ui/Spinner';
import { Badge } from '@/components/ui/Badge';
import { formatRelativeTime } from '@/utils';
import styles from './MentionsPanel.module.css';

interface MentionsPanelProps {
  onClose?: () => void;
}

export function MentionsPanel({ onClose }: MentionsPanelProps) {
  const { mentions, unreadCount, isLoading, markAsRead, loadMore, hasMore } = useMentions();
  const navigate = useNavigate();
  const [channelFilter, setChannelFilter] = useState<string>('all');

  const channelOptions = useMemo(() => {
    const channelMap = new Map<string, string>();
    for (const m of mentions) {
      if (!channelMap.has(m.channel_id)) {
        channelMap.set(m.channel_id, m.channel_name);
      }
    }
    return Array.from(channelMap.entries());
  }, [mentions]);

  const filteredMentions = useMemo(() => {
    if (channelFilter === 'all') return mentions;
    return mentions.filter((m) => m.channel_id === channelFilter);
  }, [mentions, channelFilter]);

  const handleNavigate = useCallback(
    (mention: typeof mentions[0]) => {
      markAsRead(mention.id);
      navigate(`/channels/${mention.channel_id}#message-${mention.message_id}`);
      onClose?.();
    },
    [navigate, markAsRead, onClose],
  );

  if (isLoading && mentions.length === 0) {
    return (
      <div className={styles.loading}>
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3 className={styles.title}>Mentions</h3>
        {unreadCount > 0 && (
          <Badge variant="error" size="sm">{unreadCount}</Badge>
        )}
      </div>
      {channelOptions.length > 1 && (
        <div className={styles.filterWrapper}>
          <select
            className={styles.filterSelect}
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
          >
            <option value="all">All channels</option>
            {channelOptions.map(([id, name]) => (
              <option key={id} value={id}>#{name}</option>
            ))}
          </select>
        </div>
      )}
      <ScrollArea className={styles.list}>
        {filteredMentions.length === 0 ? (
          <div className={styles.empty}>
            <p>No mentions</p>
          </div>
        ) : (
          <>
            {filteredMentions.map((mention) => (
              <button
                key={mention.id}
                type="button"
                className={`${styles.item} ${!mention.read ? styles.unread : ''}`}
                onClick={() => handleNavigate(mention)}
              >
                <div className={styles.avatar}>
                  <Avatar
                    name={mention.mentioned_by ?? 'User'}
                    size="sm"
                  />
                </div>
                <div className={styles.content}>
                  <div className={styles.meta}>
                    <span className={styles.channelName}>#{mention.channel_name}</span>
                    <span className={styles.time}>{formatRelativeTime(mention.created_at)}</span>
                  </div>
                  <p className={styles.preview}>{mention.content}</p>
                </div>
                {!mention.read && <span className={styles.unreadDot} />}
              </button>
            ))}
            {hasMore && (
              <button
                type="button"
                className={styles.loadMore}
                onClick={loadMore}
              >
                Load more
              </button>
            )}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
