import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useToast } from '@/components/ui/Toast';
import { acceptInvitation, declineInvitation } from '@/lib/workspace';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { UserInvitation } from '@/lib/workspace';
import styles from './InvitationCard.module.css';

interface InvitationCardProps {
  invitation: UserInvitation;
  onAccepted?: () => void;
  onDeclined?: () => void;
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatExpiry(expiresAt: string): string {
  const now = new Date();
  const expiry = new Date(expiresAt);
  const diff = expiry.getTime() - now.getTime();
  if (diff <= 0) return 'Expired';
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  if (days === 1) return 'Expires tomorrow';
  return `Expires in ${days} days`;
}

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'error' }> = {
  pending: { label: 'Pending', variant: 'default' },
  accepted: { label: 'Accepted', variant: 'success' },
  declined: { label: 'Declined', variant: 'warning' },
  expired: { label: 'Expired', variant: 'error' },
  cancelled: { label: 'Cancelled', variant: 'warning' },
};

export function InvitationCard({ invitation, onAccepted, onDeclined }: InvitationCardProps) {
  const { userId, user } = useAuth();
  const { refreshWorkspaces, switchWorkspace } = useWorkspace();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [isProcessing, setIsProcessing] = useState(false);
  const [localStatus, setLocalStatus] = useState(invitation.status);

  useEffect(() => {
    setLocalStatus(invitation.status);
  }, [invitation.status]);

  const isPending = localStatus === 'pending';
  const userEmail = user?.email?.toLowerCase();
  const emailMismatch = isPending && userEmail && invitation.email.toLowerCase() !== userEmail;

  async function handleAccept() {
    if (!userId) {
      navigate(`/signin?invite=${invitation.token}`);
      return;
    }

    setIsProcessing(true);
    try {
      const result = await acceptInvitation(invitation.id, userId, user?.email ?? undefined);
      if (result.success) {
        setLocalStatus('accepted');
        toast({ variant: 'success', description: 'You joined the workspace!' });
        onAccepted?.();
        await refreshWorkspaces();
        if (invitation.workspace?.slug) {
          await switchWorkspace(invitation.workspace.slug);
        }
        setTimeout(() => navigate('/'), 800);
      } else {
        toast({ variant: 'error', description: result.error || 'Failed to accept invitation.' });
      }
    } catch {
      toast({ variant: 'error', description: 'An unexpected error occurred.' });
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleGoToWorkspace() {
    if (invitation.workspace?.slug) {
      await switchWorkspace(invitation.workspace.slug);
    }
    navigate('/');
  }

  async function handleDecline() {
    setIsProcessing(true);
    try {
      const success = await declineInvitation(invitation.id);
      if (success) {
        setLocalStatus('declined');
        toast({ variant: 'success', description: 'Invitation declined.' });
        onDeclined?.();
      } else {
        toast({ variant: 'error', description: 'Failed to decline invitation.' });
      }
    } catch {
      toast({ variant: 'error', description: 'An unexpected error occurred.' });
    } finally {
      setIsProcessing(false);
    }
  }

  const statusConfig = STATUS_CONFIG[localStatus] ?? STATUS_CONFIG.pending;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.workspaceInfo}>
          <Avatar
            src={invitation.workspace?.avatar_url ?? undefined}
            name={invitation.workspace?.name || 'W'}
            size="md"
          />
          <div className={styles.workspaceDetails}>
            <span className={styles.workspaceName}>{invitation.workspace?.name || 'Unknown workspace'}</span>
            {invitation.workspace?.description && (
              <span className={styles.workspaceDescription}>{invitation.workspace.description}</span>
            )}
          </div>
        </div>
        <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
      </div>

      <div className={styles.meta}>
        <div className={styles.inviterInfo}>
          {invitation.inviterProfile && (
            <div className={styles.inviter}>
              <Avatar
                src={invitation.inviterProfile.avatar_url ?? undefined}
                name={invitation.inviterProfile.display_name || invitation.inviterProfile.username || 'U'}
                size="xs"
              />
              <span className={styles.inviterName}>
                Invited by {invitation.inviterProfile.display_name || invitation.inviterProfile.username || 'Unknown'}
              </span>
            </div>
          )}
          <div className={styles.details}>
            <span className={styles.role}>Role: <strong>{invitation.role}</strong></span>
            <span className={styles.dot} aria-hidden="true">·</span>
            <span className={styles.date}>Sent {formatRelativeTime(invitation.created_at)}</span>
            {isPending && (
              <>
                <span className={styles.dot} aria-hidden="true">·</span>
                <span className={styles.expiry}>{formatExpiry(invitation.expires_at)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {emailMismatch && (
        <div className={styles.emailMismatch}>
          This invitation was sent to <strong>{invitation.email}</strong>, but you are signed in as <strong>{user?.email}</strong>.
        </div>
      )}

      {isPending && (
        <div className={styles.actions}>
          <Button
            size="sm"
            onClick={handleAccept}
            loading={isProcessing}
            disabled={isProcessing || !!emailMismatch}
          >
            Accept
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDecline}
            loading={isProcessing}
            disabled={isProcessing}
          >
            Decline
          </Button>
        </div>
      )}

      {!isPending && localStatus === 'accepted' && invitation.workspace && (
        <div className={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleGoToWorkspace}
          >
            Go to workspace
          </Button>
        </div>
      )}
    </div>
  );
}
