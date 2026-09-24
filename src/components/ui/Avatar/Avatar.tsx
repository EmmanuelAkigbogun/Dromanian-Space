import { useState } from 'react';
import { isEmojiAvatarUrl } from './isEmojiAvatarUrl';
import styles from './Avatar.module.css';

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
type AvatarStatus = 'online' | 'offline' | 'away' | 'busy';

interface AvatarProps {
  src?: string;
  alt?: string;
  name?: string;
  size?: AvatarSize;
  status?: AvatarStatus | null;
  className?: string;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

const STATUS_CLASS_MAP: Record<AvatarStatus, string> = {
  online: styles.statusOnline,
  offline: styles.statusOffline,
  away: styles.statusAway,
  busy: styles.statusBusy,
};

export function Avatar({ src, alt, name = '', size = 'md', status, className }: AvatarProps) {
  const [imgError, setImgError] = useState(false);
  const classes = [styles.avatar, styles[size], className].filter(Boolean).join(' ');

  const isEmoji = isEmojiAvatarUrl(src) && !imgError;
  const showImage = src && !imgError && !isEmoji;
  const initials = getInitials(name);
  const statusClass = status ? STATUS_CLASS_MAP[status] : null;

  return (
    <div className={styles.wrapper}>
      <div
        className={`${classes} ${isEmoji ? styles.emojiVariant : ''}`}
        role="img"
        aria-label={name || 'Avatar'}
      >
        {showImage ? (
          <img
            className={styles.image}
            src={src}
            alt={alt || name}
            onError={() => setImgError(true)}
          />
        ) : isEmoji ? (
          <span className={styles.emoji}>{src}</span>
        ) : (
          <span className={styles.initials}>{initials}</span>
        )}
      </div>
      {status && statusClass && (
        <span className={`${styles.statusIndicator} ${statusClass}`} aria-label={`Status: ${status}`} />
      )}
    </div>
  );
}
