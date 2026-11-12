import { Popover, Trigger, Content } from '@/components/ui/Popover/Popover';
import type { Receipt } from '@/hooks/useChannelReceipts';
import styles from './MessageReceipt.module.css';

interface MessageReceiptProps {
  receipt: Receipt;
  sentAt: string;
  nameOf: (userId: string) => string | undefined;
  /** A concise group-chat summary, shown only for the latest outgoing message. */
  seenBy?: string;
}

const STATUS_LABELS = {
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
} as const;

function formatDetailTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function MessageReceipt({ receipt, sentAt, nameOf, seenBy }: MessageReceiptProps) {
  const label = STATUS_LABELS[receipt.status];
  const sentTime = formatDetailTime(sentAt);

  return (
    <Popover>
      <Trigger asChild>
        <button
          type="button"
          className={`${styles.trigger} ${receipt.status === 'read' ? styles.read : ''}`}
          aria-label={`Message status: ${label}. Show delivery details`}
          aria-haspopup="dialog"
          title="Show message status details"
          data-no-select
        >
          <span>{label}</span>
          {seenBy && <span className={styles.summary}>/ {seenBy}</span>}
        </button>
      </Trigger>
      <Content side="top" align="end" sideOffset={6}>
        <section className={styles.details} aria-label="Message delivery details">
          <div className={styles.headingRow}>
            <h3 className={styles.heading}>Message status</h3>
            <span className={`${styles.badge} ${receipt.status === 'read' ? styles.badgeRead : ''}`}>{label}</span>
          </div>
          <p className={styles.sentAt}>Sent {sentTime || 'recently'}</p>
          <ul className={styles.participants}>
            {receipt.participants.map((participant, index) => {
              const participantStatus = participant.readAt
                ? 'Read'
                : participant.deliveredAt
                  ? 'Delivered'
                  : 'Sent';
              return (
                <li className={styles.participant} key={participant.userId}>
                  <span className={styles.participantName}>{nameOf(participant.userId) ?? `Participant ${index + 1}`}</span>
                  <span className={styles.participantStatus}>{participantStatus}</span>
                </li>
              );
            })}
          </ul>
        </section>
      </Content>
    </Popover>
  );
}
