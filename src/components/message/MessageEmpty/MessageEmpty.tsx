import { memo } from 'react';
import styles from './MessageEmpty.module.css';

interface MessageEmptyProps {
  channelName?: string;
}

export const MessageEmpty = memo(function MessageEmpty({ channelName }: MessageEmptyProps) {
  return (
    <div className={styles.container}>
      <div className={styles.icon}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      </div>
      <h3 className={styles.title}>Welcome to #{channelName || 'channel'}</h3>
      <p className={styles.description}>
        This is the start of the conversation. Send a message to get things going!
      </p>
    </div>
  );
});
