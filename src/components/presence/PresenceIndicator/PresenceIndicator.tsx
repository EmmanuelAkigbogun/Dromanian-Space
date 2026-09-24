import type { PresenceStatus } from '@/app/providers/PresenceProvider';
import styles from './PresenceIndicator.module.css';

type IndicatorSize = 'sm' | 'md' | 'lg';

interface PresenceIndicatorProps {
  status: PresenceStatus;
  size?: IndicatorSize;
  className?: string;
}

const STATUS_LABELS: Record<PresenceStatus, string> = {
  online: 'Online',
  away: 'Away',
  busy: 'Busy',
  invisible: 'Invisible',
  offline: 'Offline',
};

export function PresenceIndicator({ status, size = 'md', className }: PresenceIndicatorProps) {
  const classes = [styles.indicator, styles[size], styles[status], className]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={classes}
      role="img"
      aria-label={STATUS_LABELS[status]}
      title={STATUS_LABELS[status]}
    />
  );
}
