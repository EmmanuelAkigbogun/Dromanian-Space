import { memo, useCallback } from 'react';
import styles from './FailedMessageBanner.module.css';

interface FailedMessageBannerProps {
  content: string;
  tempId: string;
  onRetry: (tempId: string) => void;
  onRemove: (tempId: string) => void;
}

export const FailedMessageBanner = memo(function FailedMessageBanner({
  content,
  tempId,
  onRetry,
  onRemove,
}: FailedMessageBannerProps) {
  const handleRetry = useCallback(() => onRetry(tempId), [onRetry, tempId]);
  const handleRemove = useCallback(() => onRemove(tempId), [onRemove, tempId]);

  return (
    <div className={styles.banner} role="alert">
      <div className={styles.content}>
        <svg className={styles.icon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span className={styles.text}>{content}</span>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.retryButton} onClick={handleRetry}>
          Retry
        </button>
        <button type="button" className={styles.removeButton} onClick={handleRemove} aria-label="Remove">
          ✕
        </button>
      </div>
    </div>
  );
});
