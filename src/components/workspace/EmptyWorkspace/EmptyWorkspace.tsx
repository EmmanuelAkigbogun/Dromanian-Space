import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { getUserInvitationsByEmail } from '@/lib/workspace';
import { InvitationCard } from '@/components/workspace/members/InvitationCard';
import { Button } from '@/components/ui/Button';
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog';
import type { UserInvitation } from '@/lib/workspace';
import styles from './EmptyWorkspace.module.css';

interface EmptyWorkspaceProps {
  onSkip?: () => void;
}

export function EmptyWorkspace({ onSkip }: EmptyWorkspaceProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const navigate = useNavigate();
  const { user } = useAuth();
  const [invitations, setInvitations] = useState<UserInvitation[]>([]);

  const fetchInvitations = useCallback(async () => {
    if (!user?.email) return;
    try {
      const data = await getUserInvitationsByEmail(user.email);
      setInvitations(data.filter((inv) => inv.status === 'pending'));
    } catch (err) {
      console.error('Failed to load pending invitations:', err);
    }
  }, [user?.email]);

  useEffect(() => {
    fetchInvitations();
  }, [fetchInvitations]);

  useEffect(() => {
    if (!user?.email) return;

    const normalizedEmail = user.email.toLowerCase().trim();
    const channel = supabase
      .channel(`empty-invitations:${Math.random().toString(36).slice(2, 9)}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'invitations',
          filter: `email=eq.${normalizedEmail}`,
        },
        () => {
          fetchInvitations();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.email, fetchInvitations]);

  const pendingCount = invitations.length;

  return (
    <>
      <div className={styles.container}>
        {pendingCount > 0 && (
          <div className={styles.invites}>
            <h3 className={styles.invitesTitle}>
              You have {pendingCount} pending invitation{pendingCount === 1 ? '' : 's'}
            </h3>
            {invitations.map((invitation) => (
              <InvitationCard
                key={invitation.id}
                invitation={invitation}
                onAccepted={fetchInvitations}
                onDeclined={fetchInvitations}
              />
            ))}
          </div>
        )}

        <div className={styles.icon}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
        </div>
        <h2 className={styles.title}>No workspaces yet</h2>
        <p className={styles.description}>
          Create your first workspace or check for pending invitations to start collaborating.
        </p>
        <div className={styles.actions}>
          <Button onClick={() => setIsDialogOpen(true)} size="lg">
            Create workspace
          </Button>
          <button
            type="button"
            className={styles.skipButton}
            onClick={() => navigate('/invitations')}
          >
            Check invitations
          </button>
          {onSkip && (
            <button type="button" className={styles.skipButton} onClick={onSkip}>
              I'll do this later
            </button>
          )}
        </div>
      </div>

      <CreateWorkspaceDialog open={isDialogOpen} onClose={() => setIsDialogOpen(false)} />
    </>
  );
}
