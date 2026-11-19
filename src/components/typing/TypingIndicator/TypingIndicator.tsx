import { useMemo } from 'react';
import { useTypingIndicator } from '@/hooks/useTypingIndicator';
import { useProfiles } from '@/hooks/useProfiles';
import { Avatar } from '@/components/ui/Avatar';
import type { UUID } from '@/types';
import styles from './TypingIndicator.module.css';

interface TypingIndicatorProps {
  channelId: UUID;
  channelType: 'channel' | 'conversation';
}

function formatTypingText(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names[0]} and ${names.length - 1} others are typing`;
}

/** "Kate is typing…" with a bubble of bouncing dots, like WhatsApp. */
export function TypingIndicator({ channelId, channelType }: TypingIndicatorProps) {
  const { typingUsers } = useTypingIndicator(channelId, channelType);
  const ids = useMemo(() => [...typingUsers.entries()].sort((a, b) => b[1].timestamp - a[1].timestamp).map(([id]) => id), [typingUsers]);
  const { profiles } = useProfiles(ids);
  const names = ids.map((id) => typingUsers.get(id)?.name || profiles.get(id)?.display_name || profiles.get(id)?.username || 'Someone');
  const text = formatTypingText(names);
  if (!text) return null;
  const first = profiles.get(ids[0]);
  return (
    <div className={styles.container} aria-live="polite">
      <Avatar src={first?.avatar_url || undefined} name={names[0]} size="xs" />
      <span className={styles.bubble} aria-hidden="true">
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
      </span>
      <span className={styles.text}>{text}…</span>
    </div>
  );
}
