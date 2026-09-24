import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import styles from './ChannelNotFound.module.css';

export function ChannelNotFound() {
  const navigate = useNavigate();

  return (
    <div className={styles.container}>
      <div className={styles.icon}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M16 16s-1.5-2-4-2-4 2-4 2" />
          <line x1="9" y1="9" x2="9.01" y2="9" />
          <line x1="15" y1="9" x2="15.01" y2="9" />
        </svg>
      </div>
      <h2 className={styles.title}>Channel not found</h2>
      <p className={styles.description}>
        This channel may have been deleted or you don't have access to it.
      </p>
      <Button onClick={() => navigate('/channels')} variant="secondary">
        Back to channels
      </Button>
    </div>
  );
}
