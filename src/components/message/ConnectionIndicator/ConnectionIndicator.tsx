import { memo } from 'react';
import type { ConnectionStatus } from '@/app/providers/MessageProvider';
import styles from './ConnectionIndicator.module.css';

interface ConnectionIndicatorProps {
  status: ConnectionStatus;
}

const STATUS_CONFIG: Record<ConnectionStatus, { label: string; className: string }> = {
  connected: { label: '', className: '' },
  connecting: { label: 'Connecting...', className: styles.connecting },
  reconnecting: { label: 'Reconnecting...', className: styles.reconnecting },
  disconnected: { label: 'Disconnected', className: styles.disconnected },
};

export const ConnectionIndicator = memo(function ConnectionIndicator({ status }: ConnectionIndicatorProps) {
  if (status === 'connected') return null;

  const config = STATUS_CONFIG[status];

  return (
    <div className={`${styles.bar} ${config.className}`} role="status" aria-live="polite">
      <span className={styles.dot} />
      <span>{config.label}</span>
    </div>
  );
});
