import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import type { AutomationEditRequest } from '@/types';
import styles from './AutomationEditRequestsDialog.module.css';

interface AutomationEditRequestsDialogProps {
  open: boolean;
  requests: AutomationEditRequest[];
  currentUserId: string | null;
  onRespond: (requestId: string, accept: boolean) => Promise<boolean>;
  onCancel: (requestId: string) => Promise<boolean>;
  onRevoke: (ruleId: string, userId: string) => Promise<boolean>;
  onClose: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  accepted: 'Approved',
  rejected: 'Declined',
};

function StatusBadge({ status }: { status: string }) {
  const className = status === 'pending' ? styles.statusPending : status === 'accepted' ? styles.statusAccepted : styles.statusRejected;
  return <span className={`${styles.statusBadge} ${className}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function AutomationEditRequestsDialog({
  open,
  requests,
  currentUserId,
  onRespond,
  onCancel,
  onRevoke,
  onClose,
}: AutomationEditRequestsDialogProps) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const incoming = requests.filter((r) => r.requester_id !== currentUserId);
  const outgoing = requests.filter((r) => r.requester_id === currentUserId);

  const handleRespond = async (requestId: string, accept: boolean) => {
    setBusyId(requestId);
    await onRespond(requestId, accept);
    setBusyId(null);
  };

  const handleCancel = async (requestId: string) => {
    setBusyId(`cancel-${requestId}`);
    await onCancel(requestId);
    setBusyId(null);
  };

  const handleRevoke = async (ruleId: string, userId: string) => {
    setBusyId(`revoke-${ruleId}-${userId}`);
    await onRevoke(ruleId, userId);
    setBusyId(null);
  };

  return (
    <Dialog open={open} onClose={onClose} title="Edit requests" size="md">
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Requests for your automations</h3>
        {incoming.length === 0 ? (
          <p className={styles.empty}>No members have asked to edit your automations.</p>
        ) : (
          <div className={styles.list}>
            {incoming.map((request) => (
              <div key={request.id} className={styles.row}>
                <div className={styles.rowInfo}>
                  <span className={styles.rowTitle}>{request.rule_name}</span>
                  <span className={styles.rowMeta}>{request.requester_name} · <StatusBadge status={request.status} /></span>
                </div>
                {request.status === 'pending' && (
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.acceptButton}
                      disabled={busyId === request.id}
                      onClick={() => handleRespond(request.id, true)}
                    >
                      {busyId === request.id ? '...' : 'Accept'}
                    </button>
                    <button
                      type="button"
                      className={styles.rejectButton}
                      disabled={busyId === request.id}
                      onClick={() => handleRespond(request.id, false)}
                    >
                      Decline
                    </button>
                  </div>
                )}
                {request.status === 'accepted' && (
                  <button
                    type="button"
                    className={styles.revokeButton}
                    disabled={busyId === `revoke-${request.rule_id}-${request.requester_id}`}
                    onClick={() => handleRevoke(request.rule_id, request.requester_id)}
                  >
                    Revoke access
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>My requests</h3>
        {outgoing.length === 0 ? (
          <p className={styles.empty}>You haven&apos;t requested edit access on any automation.</p>
        ) : (
          <div className={styles.list}>
            {outgoing.map((request) => (
              <div key={request.id} className={styles.row}>
                <div className={styles.rowInfo}>
                  <span className={styles.rowTitle}>{request.rule_name}</span>
                  <span className={styles.rowMeta}><StatusBadge status={request.status} /></span>
                </div>
                {request.status === 'pending' && (
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.cancelButton}
                      disabled={busyId === `cancel-${request.id}`}
                      onClick={() => handleCancel(request.id)}
                    >
                      {busyId === `cancel-${request.id}` ? '...' : 'Cancel request'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className={styles.hint}>
        Approving a request lets that member edit and delete the automation until you revoke access.
      </p>
    </Dialog>
  );
}
