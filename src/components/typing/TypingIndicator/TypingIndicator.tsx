import { useMemo } from 'react';
import { useTypingIndicator } from '@/hooks/useTypingIndicator';
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

export function TypingIndicator({ channelId, channelType }: TypingIndicatorProps) {
  const { typingUsers } = useTypingIndicator(channelId, channelType);

  const names = useMemo(
    () =>
      Array.from(typingUsers.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((u) => u.name || 'Someone'),
    [typingUsers],
  );

  const text = formatTypingText(names);

  if (!text) return null;

  return (
    <div className={styles.container} aria-live="polite">
      <span className={styles.dots}>
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
      </span>
      <span className={styles.text}>{text}...</span>
    </div>
  );
}
