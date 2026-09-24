import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import { getUserInvitationsByEmail } from '@/lib/workspace';
import { canInviteMembers } from '@/lib/workspace/permissions';
import { InvitationCard } from '@/components/workspace/members/InvitationCard';
import { InvitationsList } from '@/components/workspace/members/InvitationsList';
import { JoinRequestsList } from '@/components/workspace/members/JoinRequestsList';
import { Spinner } from '@/components/ui/Spinner';
import type { UserInvitation } from '@/lib/workspace';
import styles from './Invitations.module.css';

type Filter = 'all' | 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
type Tab = 'my' | 'workspace' | 'join-requests';

export function Invitations() {
  const { user } = useAuth();
  const { currentRole } = useWorkspace();
  const canInvite = canInviteMembers(currentRole);
  const [activeTab, setActiveTab] = useState<Tab>('my');
  const [invitations, setInvitations] = useState<UserInvitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');

  const fetchInvitations = useCallback(async () => {
    if (!user?.email) return;
    setIsLoading(true);
    try {
      const data = await getUserInvitationsByEmail(user.email);
      setInvitations(data);
    } catch (err) {
      console.error('Failed to load invitations:', err);
      setInvitations([]);
    } finally {
      setIsLoading(false);
    }
  }, [user?.email]);

  useEffect(() => {
    fetchInvitations();
  }, [fetchInvitations]);

  useEffect(() => {
    if (!user?.email) return;

    const normalizedEmail = user.email.toLowerCase().trim();
    const channel = supabase
      .channel(`invitations-email:${Math.random().toString(36).slice(2, 9)}`)
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

  const filtered = filter === 'all'
    ? invitations
    : invitations.filter((inv) => inv.status === filter);

  const pendingCount = invitations.filter((inv) => inv.status === 'pending').length;

  function handleAccepted() {
    fetchInvitations();
  }

  function handleDeclined() {
    fetchInvitations();
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Invitations</h1>
          <p className={styles.description}>
            Manage invitations and join requests for your workspace.
          </p>
        </div>
      </div>

      <div className={styles.tabs}>
        <button
          type="button"
          className={`${styles.tab} ${activeTab === 'my' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('my')}
        >
          My Invitations
          {pendingCount > 0 && <span className={styles.tabBadge}>{pendingCount}</span>}
        </button>
        <button
          type="button"
          className={`${styles.tab} ${activeTab === 'workspace' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('workspace')}
        >
          Workspace Invitations
        </button>
        {canInvite && (
          <button
            type="button"
            className={`${styles.tab} ${activeTab === 'join-requests' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('join-requests')}
          >
            Join Requests
          </button>
        )}
      </div>

      {activeTab === 'my' && (
        <>
          <div className={styles.filters}>
            {(['all', 'pending', 'accepted', 'declined', 'expired', 'cancelled'] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`${styles.filterButton} ${filter === f ? styles.filterActive : ''}`}
                onClick={() => setFilter(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
                {f === 'pending' && pendingCount > 0 && (
                  <span className={styles.badge}>{pendingCount}</span>
                )}
              </button>
            ))}
          </div>

          {isLoading ? (
            <div className={styles.loading}>
              <Spinner size="md" />
            </div>
          ) : filtered.length === 0 ? (
            <div className={styles.empty}>
              {invitations.length === 0 ? (
                <>
                  <div className={styles.emptyIcon}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                      <polyline points="22,6 12,13 2,6" />
                    </svg>
                  </div>
                  <h3 className={styles.emptyTitle}>No invitations</h3>
                  <p className={styles.emptyDescription}>
                    When someone invites you to a workspace, it will appear here.
                  </p>
                </>
              ) : (
                <>
                  <h3 className={styles.emptyTitle}>No {filter} invitations</h3>
                  <p className={styles.emptyDescription}>
                    Try a different filter to see your invitations.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className={styles.list}>
              {filtered.map((invitation) => (
                <InvitationCard
                  key={invitation.id}
                  invitation={invitation}
                  onAccepted={handleAccepted}
                  onDeclined={handleDeclined}
                />
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === 'workspace' && (
        <div className={styles.panel}>
          <InvitationsList />
        </div>
      )}

      {activeTab === 'join-requests' && canInvite && (
        <div className={styles.panel}>
          <JoinRequestsList />
        </div>
      )}
    </div>
  );
}
