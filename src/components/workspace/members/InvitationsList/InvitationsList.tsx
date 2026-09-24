import { useState, useEffect, useCallback } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { getWorkspaceInvitations, cancelInvitation, resendInvitation, deleteInvitation } from '@/lib/workspace';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import type { Invitation, InvitationStatus } from '@/types';
import styles from './InvitationsList.module.css';

const STATUS_VARIANT: Record<InvitationStatus, 'default' | 'success' | 'warning' | 'error'> = {
  pending: 'default',
  accepted: 'success',
  declined: 'warning',
  expired: 'error',
  cancelled: 'warning',
};

export function InvitationsList() {
  const { currentWorkspace } = useWorkspace();
  const { toast } = useToast();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);

  const fetchInvitations = useCallback(async () => {
    if (!currentWorkspace) return;
    setIsLoading(true);
    const data = await getWorkspaceInvitations(currentWorkspace.id);
    setInvitations(data);
    setIsLoading(false);
  }, [currentWorkspace]);

  useEffect(() => {
    fetchInvitations();
  }, [fetchInvitations]);

  useEffect(() => {
    const handleInvitationsUpdated = () => fetchInvitations();
    window.addEventListener('invitations-updated', handleInvitationsUpdated);
    return () => window.removeEventListener('invitations-updated', handleInvitationsUpdated);
  }, [fetchInvitations]);

  async function handleCancel(invitationId: string) {
    setActionId(invitationId);
    const success = await cancelInvitation(invitationId);
    if (success) {
      setInvitations((prev) =>
        prev.map((inv) => (inv.id === invitationId ? { ...inv, status: 'cancelled' as const } : inv)),
      );
      toast({ variant: 'success', description: 'Invitation cancelled.' });
    } else {
      toast({ variant: 'error', description: 'Failed to cancel invitation.' });
    }
    setActionId(null);
  }

  async function handleDelete(invitationId: string) {
    setActionId(invitationId);
    const success = await deleteInvitation(invitationId);
    if (success) {
      setInvitations((prev) => prev.filter((inv) => inv.id !== invitationId));
      toast({ variant: 'success', description: 'Invitation deleted.' });
    } else {
      toast({ variant: 'error', description: 'Failed to delete invitation.' });
    }
    setActionId(null);
  }

  async function handleResend(invitationId: string) {
    setActionId(invitationId);
    const updated = await resendInvitation(invitationId);
    if (updated) {
      setInvitations((prev) =>
        prev.map((inv) => (inv.id === invitationId ? updated : inv)),
      );
      toast({ variant: 'success', description: 'Invitation resent with a new expiry date.' });
    } else {
      toast({ variant: 'error', description: 'Failed to resend invitation.' });
    }
    setActionId(null);
  }

  function formatExpiry(expiresAt: string): string {
    const now = new Date();
    const expiry = new Date(expiresAt);
    const days = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (days <= 0) return 'Expired';
    if (days === 1) return 'Expires tomorrow';
    return `Expires in ${days} days`;
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <Spinner size="md" />
      </div>
    );
  }

  const pending = invitations.filter((inv) => inv.status === 'pending');
  const history = invitations.filter((inv) => inv.status !== 'pending');

  return (
    <div>
      {pending.length === 0 && history.length === 0 && (
        <p className={styles.empty}>No invitations yet.</p>
      )}

      {pending.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>Pending</h3>
          <ul className={styles.list}>
            {pending.map((invitation) => (
              <li key={invitation.id} className={styles.invitation}>
                <div className={styles.invitationInfo}>
                  <span className={styles.invitationEmail}>{invitation.email}</span>
                  <div className={styles.invitationMeta}>
                    <Badge variant="default">{invitation.role}</Badge>
                    <span className={styles.invitationExpiry}>{formatExpiry(invitation.expires_at)}</span>
                  </div>
                </div>
                <div className={styles.invitationActions}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleResend(invitation.id)}
                    loading={actionId === invitation.id}
                  >
                    Resend
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCancel(invitation.id)}
                    loading={actionId === invitation.id}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleDelete(invitation.id)}
                    loading={actionId === invitation.id}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {history.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>History</h3>
          <ul className={styles.list}>
            {history.map((invitation) => (
              <li key={invitation.id} className={styles.invitation}>
                <div className={styles.invitationInfo}>
                  <span className={styles.invitationEmail}>{invitation.email}</span>
                  <div className={styles.invitationMeta}>
                    <Badge variant={STATUS_VARIANT[invitation.status]}>{invitation.status}</Badge>
                    <span className={styles.invitationDate}>{formatDate(invitation.created_at)}</span>
                  </div>
                </div>
                {invitation.status !== 'accepted' && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleResend(invitation.id)}
                      loading={actionId === invitation.id}
                    >
                      Resend
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleDelete(invitation.id)}
                      loading={actionId === invitation.id}
                    >
                      Delete
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
