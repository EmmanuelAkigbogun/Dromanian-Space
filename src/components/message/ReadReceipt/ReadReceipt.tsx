import { useReadReceipts, type ReceiptStatus } from '@/hooks/useReadReceipts';
import type { UUID } from '@/types';
import styles from './ReadReceipt.module.css';

interface ReadReceiptProps {
  messageId: UUID;
  channelId?: UUID;
  className?: string;
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="11"
      viewBox="0 0 16 11"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M1 5.5L5.5 10L14.5 1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DoubleCheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="11"
      viewBox="0 0 18 11"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M1 5.5L5.5 10L14.5 1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 5.5L9.5 10L18 1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const STATUS_LABELS: Record<ReceiptStatus, string> = {
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
};

export function ReadReceipt({ messageId, channelId: _channelId, className }: ReadReceiptProps) {
  const { getReceiptStatus, getReadCount } = useReadReceipts();
  const status: ReceiptStatus = getReceiptStatus(messageId);
  const readCount = getReadCount(messageId);

  const classes = [styles.receipt, styles[status], className].filter(Boolean).join(' ');

  if (status === 'sent') {
    return (
      <span className={classes} title={STATUS_LABELS[status]}>
        <CheckIcon className={styles.icon} />
      </span>
    );
  }

  return (
    <span
      className={classes}
      title={readCount > 0 ? `${STATUS_LABELS[status]} by ${readCount}` : STATUS_LABELS[status]}
    >
      <DoubleCheckIcon className={styles.icon} />
    </span>
  );
}
