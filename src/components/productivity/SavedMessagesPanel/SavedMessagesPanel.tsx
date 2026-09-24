import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useChannel } from '@/hooks/useChannel';
import { Avatar } from '@/components/ui/Avatar';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { formatRelativeTime } from '@/utils';
import type { Message, Profile } from '@/types';
import styles from './SavedMessagesPanel.module.css';

interface SavedMessageWithDetails {
  id: string;
  message_id: string;
  created_at: string;
  message: Message | null;
  sender: Profile | null;
  channel_name: string | null;
}

interface SavedMessagesPanelProps {
  onClose?: () => void;
}

export function SavedMessagesPanel({ onClose }: SavedMessagesPanelProps) {
  const { userId } = useAuth();
  const { channels } = useChannel();
  const navigate = useNavigate();
  const [savedMessages, setSavedMessages] = useState<SavedMessageWithDetails[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const channelSlugsRef = useRef<Record<string, string>>({});

  const fetchSavedMessages = useCallback(async () => {
    if (!userId) return;
    setIsLoading(true);

    try {
      const { data: saved, error } = await supabase
        .from('saved_messages' as any)
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      if (!saved || saved.length === 0) {
        setSavedMessages([]);
        return;
      }

      const wsChannelIds = channels.map((c) => c.id);
      const messageIds = saved.map((s: any) => s.message_id);
      const { data: messages } = await supabase
        .from('messages')
        .select('*')
        .in('id', messageIds)
        .in('channel_id', wsChannelIds);

      const messageMap = new Map((messages as Message[] ?? []).map((m) => [m.id, m]));
      const senderIds = [...new Set((messages as Message[] ?? []).map((m) => m.user_id))];
      const channelIds = [...new Set((messages as Message[] ?? []).map((m) => m.channel_id))];

      let profiles: Profile[] = [];
      if (senderIds.length > 0) {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('*')
          .in('id', senderIds);
        profiles = (profileData as Profile[]) ?? [];
      }

      let channelNames: Record<string, string> = {};
      if (channelIds.length > 0) {
        const { data: channels } = await supabase
          .from('channels')
          .select('id, name, slug')
          .in('id', channelIds);
        for (const ch of (channels ?? []) as any[]) {
          channelNames[ch.id] = ch.name;
          channelSlugsRef.current[ch.id] = ch.slug;
        }
      }

      const profileMap = new Map(profiles.map((p) => [p.id, p]));

      const enriched: SavedMessageWithDetails[] = saved
        .map((s: any) => {
          const msg = messageMap.get(s.message_id) ?? null;
          return {
            id: s.id,
            message_id: s.message_id,
            created_at: s.created_at,
            message: msg,
            sender: msg ? profileMap.get(msg.user_id) ?? null : null,
            channel_name: msg ? channelNames[msg.channel_id] ?? null : null,
          };
        })
        .filter((item) => item.message !== null);

      setSavedMessages(enriched);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [userId, channels]);

  useEffect(() => {
    fetchSavedMessages();
  }, [fetchSavedMessages]);

  const handleUnsave = useCallback(
    async (savedId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const { error } = await supabase
        .from('saved_messages' as any)
        .delete()
        .eq('id', savedId);
      if (!error) {
        setSavedMessages((prev) => prev.filter((s) => s.id !== savedId));
      }
    },
    [],
  );

  const handleJumpToMessage = useCallback(
    (item: SavedMessageWithDetails) => {
      const cid = item.message?.channel_id;
      if (cid) {
        const slug = channelSlugsRef.current[cid] || cid;
        navigate(`/channels/${slug}#message-${item.message_id}`);
      }
      onClose?.();
    },
    [navigate, onClose],
  );

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return savedMessages;
    const q = searchQuery.toLowerCase();
    return savedMessages.filter(
      (s) =>
        s.message?.content?.toLowerCase().includes(q) ||
        s.channel_name?.toLowerCase().includes(q),
    );
  }, [savedMessages, searchQuery]);

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
        <h3 className={styles.title}>Saved Messages</h3>
      </div>
      <div className={styles.searchWrapper}>
        <Input
          placeholder="Search saved messages..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      <ScrollArea className={styles.list}>
        {filtered.length === 0 ? (
          <div className={styles.empty}>
            <p>No saved messages</p>
          </div>
        ) : (
          filtered.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              className={styles.item}
              onClick={() => handleJumpToMessage(item)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleJumpToMessage(item); }}
            >
              <div className={styles.avatar}>
                <Avatar
                  src={item.sender?.avatar_url ?? undefined}
                  name={item.sender?.display_name ?? item.sender?.username ?? 'User'}
                  size="sm"
                />
              </div>
              <div className={styles.content}>
                <div className={styles.meta}>
                  <span className={styles.senderName}>
                    {item.sender?.display_name ?? item.sender?.username ?? 'Unknown'}
                  </span>
                  {item.channel_name && (
                    <span className={styles.channelName}>#{item.channel_name}</span>
                  )}
                  <span className={styles.time}>{formatRelativeTime(item.created_at)}</span>
                </div>
                <p className={styles.preview}>{item.message?.content ?? 'Message not available'}</p>
              </div>
              <button
                type="button"
                className={styles.unsaveButton}
                onClick={(e) => handleUnsave(item.id, e)}
                aria-label="Remove from saved"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))
        )}
      </ScrollArea>
    </div>
  );
}
