import { Button } from '@/components/ui/Button';
import styles from './ChannelEmpty.module.css';

interface ChannelEmptyProps {
  onCreateChannel?: () => void;
}

export function ChannelEmpty({ onCreateChannel }: ChannelEmptyProps) {
  return (
    <div className={styles.container}>
      <div className={styles.icon}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <h2 className={styles.title}>No channels yet</h2>
      <p className={styles.description}>
        Create your first channel to start talking with your team.
      </p>
      {onCreateChannel && (
        <Button onClick={onCreateChannel} size="lg">
          Create channel
        </Button>
      )}
    </div>
  );
}
