import { isEmojiAvatarUrl } from '@/components/ui/Avatar/isEmojiAvatarUrl';
import styles from './WorkspaceAvatar.module.css';

type WorkspaceAvatarSize = 'sm' | 'md' | 'lg';

interface WorkspaceAvatarProps {
  name: string;
  avatarUrl?: string | null;
  size?: WorkspaceAvatarSize;
  className?: string;
}

const COLORS = [
  '#82A6B1',
  '#B182A6',
  '#A6B182',
  '#B1A682',
  '#82B1A6',
  '#A682B1',
  '#B18282',
  '#82B182',
];

function getColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
}

export function WorkspaceAvatar({ name, avatarUrl, size = 'md', className }: WorkspaceAvatarProps) {
  const classes = [styles.avatar, styles[size], className].filter(Boolean).join(' ');

  if (avatarUrl && !isEmojiAvatarUrl(avatarUrl)) {
    return (
      <img
        src={avatarUrl}
        alt={`${name} avatar`}
        className={`${classes} ${styles.image}`}
      />
    );
  }

  if (avatarUrl && isEmojiAvatarUrl(avatarUrl)) {
    return (
      <span className={`${classes} ${styles.emoji}`} role="img" aria-label={`${name} avatar`}>
        {avatarUrl}
      </span>
    );
  }

  return (
    <span
      className={classes}
      style={{ backgroundColor: getColor(name) }}
      aria-hidden="true"
    >
      {getInitials(name)}
    </span>
  );
}
