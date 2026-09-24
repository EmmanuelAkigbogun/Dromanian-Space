import { useId, type ReactNode } from 'react';
import { Avatar } from '@/components/ui/Avatar/Avatar';
import type { AvatarDisplayStyle } from '@/types/profile';
import styles from './AvatarDisplay.module.css';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type AvatarStatus = 'online' | 'offline' | 'away' | 'busy';

export interface AvatarDisplayProps {
  src?: string;
  name: string;
  style?: AvatarDisplayStyle;
  size?: AvatarSize;
  status?: AvatarStatus | null;
  caption?: string;
  action?: ReactNode;
}

export function AvatarDisplay({
  src,
  name,
  style = 'circle',
  size = 'lg',
  status,
  caption,
  action,
}: AvatarDisplayProps) {
  const gradientId = useId();
  const avatar = <Avatar src={src} name={name} size={size} status={status} />;

  if (style === 'frame') {
    return (
      <div className={styles.pictureWall}>
        <svg className={styles.hanger} viewBox="0 0 120 46" aria-hidden="true">
          <defs>
            <radialGradient id={gradientId}>
              <stop offset="0%" stopColor="#d7dade" />
              <stop offset="100%" stopColor="#5f6368" />
            </radialGradient>
          </defs>
          <circle cx="60" cy="7" r="6" fill={`url(#${gradientId})`} stroke="#3d4043" strokeWidth="1.5" />
          <path d="M60 13 L26 42" className={styles.stringLine} />
          <path d="M60 13 L94 42" className={styles.stringLine} />
        </svg>

        <div className={styles.pictureFrame}>
          {avatar}
          {action}
        </div>
      </div>
    );
  }

  if (style === 'polaroid') {
    return (
      <div className={styles.polaroidCard}>
        <span className={styles.polaroidTape} aria-hidden="true" />
        <div className={styles.polaroidImage}>
          {avatar}
          {action}
        </div>
        {caption && <div className={styles.polaroidCaption}>{caption}</div>}
      </div>
    );
  }

  return (
    <div className={styles.circleWrap}>
      {avatar}
      {action}
    </div>
  );
}
