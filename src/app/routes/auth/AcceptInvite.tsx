import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout, AuthHeader, AuthError } from '@/components/auth/AuthLayout';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useAuth } from '@/hooks/useAuth';
import { getPendingInvitationByToken, acceptInvitation, declineInvitation } from '@/lib/workspace';
import { getWorkspaceById } from '@/lib/workspace';
import type { Invitation, Workspace } from '@/types';
import styles from './AcceptInvite.module.css';

const TOKEN_STORAGE_KEY = 'dark-space-invite-token';

type InviteState =
  | 'loading'
  | 'valid'
  | 'expired'
  | 'not-found'
  | 'already-accepted'
  | 'cancelled'
  | 'email-mismatch'
  | 'accepted'
  | 'declined'
  | 'error';

export function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { userId, isLoading: authLoading, user } = useAuth();

  const [state, setState] = useState<InviteState>('loading');
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const effectiveToken = token || searchParams.get('invite');

  const loadInvitation = useCallback(async (tokenToLoad: string) => {
    setState('loading');
    const inv = await getPendingInvitationByToken(tokenToLoad);

    if (!inv) {
      setState('not-found');
      return;
    }

    if (inv.status === 'accepted') {
      setState('already-accepted');
      setInvitation(inv);
      const ws = await getWorkspaceById(inv.workspace_id);
      setWorkspace(ws);
      return;
    }

    if (inv.status === 'cancelled') {
      setState('cancelled');
      setInvitation(inv);
      return;
    }

    if (inv.status === 'declined') {
      setState('declined');
      setInvitation(inv);
      return;
    }

    if (new Date(inv.expires_at) < new Date()) {
      setState('expired');
      setInvitation(inv);
      return;
    }

    const ws = await getWorkspaceById(inv.workspace_id);
    setInvitation(inv);
    setWorkspace(ws);
    setState('valid');
  }, []);

  useEffect(() => {
    if (effectiveToken) {
      try {
        localStorage.setItem(TOKEN_STORAGE_KEY, effectiveToken);
      } catch {
        // localStorage not available
      }
    }
  }, [effectiveToken]);

  useEffect(() => {
    if (authLoading) return;

    const tokenToLoad = effectiveToken || (() => {
      try {
        return localStorage.getItem(TOKEN_STORAGE_KEY);
      } catch {
        return null;
      }
    })();

    if (!tokenToLoad) {
      setState('not-found');
      return;
    }

    loadInvitation(tokenToLoad);
  }, [authLoading, effectiveToken, loadInvitation]);

  useEffect(() => {
    if (state === 'valid' && userId && invitation) {
      const userEmail = user?.email?.toLowerCase();
      if (userEmail && invitation.email.toLowerCase() !== userEmail) {
        setState('email-mismatch');
      }
    }
  }, [state, userId, invitation, user]);

  async function handleAccept() {
    if (!invitation || !userId) return;
    setIsProcessing(true);
    setErrorMessage('');
    try {
      const result = await acceptInvitation(invitation.id, userId, user?.email);
      if (result.success) {
        setState('accepted');
        try {
          localStorage.removeItem(TOKEN_STORAGE_KEY);
        } catch {
          // localStorage not available
        }
        setTimeout(() => navigate('/'), 500);
      } else {
        setErrorMessage(result.error || 'Failed to accept invitation.');
        if (result.error?.includes('expired')) {
          setState('expired');
        } else if (result.error?.includes('already been accepted')) {
          setState('already-accepted');
        } else if (result.error?.includes('cancelled')) {
          setState('cancelled');
        } else {
          setState('error');
        }
      }
    } catch {
      setState('error');
      setErrorMessage('An unexpected error occurred.');
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleDecline() {
    if (!invitation) return;
    setIsProcessing(true);
    try {
      await declineInvitation(invitation.id);
      setState('declined');
      try {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      } catch {
        // localStorage not available
      }
    } catch {
      setState('error');
      setErrorMessage('Failed to decline invitation.');
    } finally {
      setIsProcessing(false);
    }
  }

  function handleSignOut() {
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // localStorage not available
    }
    navigate('/signin');
  }

  if (state === 'loading' || authLoading) {
    return (
      <AuthLayout>
        <AuthHeader title="Invitation" />
        <div className={styles.centered}>
          <Spinner size="md" />
          <p className={styles.loadingText}>Validating invitation...</p>
        </div>
      </AuthLayout>
    );
  }

  if (state === 'not-found') {
    return (
      <AuthLayout>
        <AuthHeader
          title="Invalid invitation"
          subtitle="This invitation link is invalid or does not exist."
        />
        <div className={styles.centered}>
          <Button onClick={() => navigate('/signin')}>Go to sign in</Button>
        </div>
      </AuthLayout>
    );
  }

  if (state === 'expired') {
    return (
      <AuthLayout>
        <AuthHeader
          title="Invitation expired"
          subtitle="This invitation has expired. Please ask to be re-invited."
        />
        {workspace && invitation && (
          <div className={styles.inviteDetails}>
            <div className={styles.inviteRow}>
              <span className={styles.inviteLabel}>Workspace</span>
              <span className={styles.inviteValue}>{workspace.name}</span>
            </div>
            <div className={styles.inviteRow}>
              <span className={styles.inviteLabel}>Sent to</span>
              <span className={styles.inviteValue}>{invitation.email}</span>
            </div>
          </div>
        )}
        <div className={styles.centered}>
          <Button onClick={() => navigate('/')}>Go to home</Button>
        </div>
      </AuthLayout>
    );
  }

  if (state === 'already-accepted') {
    return (
      <AuthLayout>
        <AuthHeader
          title="Already accepted"
          subtitle="This invitation has already been accepted."
        />
        {workspace && (
          <div className={styles.inviteDetails}>
            <div className={styles.inviteRow}>
              <span className={styles.inviteLabel}>Workspace</span>
              <span className={styles.inviteValue}>{workspace.name}</span>
            </div>
          </div>
        )}
        <div className={styles.centered}>
          <Button onClick={() => navigate('/')}>Go to workspace</Button>
        </div>
      </AuthLayout>
    );
  }

  if (state === 'cancelled') {
    return (
      <AuthLayout>
        <AuthHeader
          title="Invitation cancelled"
          subtitle="This invitation has been cancelled by the sender."
        />
        <div className={styles.centered}>
          <Button onClick={() => navigate('/')}>Go to home</Button>
        </div>
      </AuthLayout>
    );
  }

  if (state === 'accepted') {
    return (
      <AuthLayout>
        <AuthHeader
          title="Welcome!"
          subtitle={`You've joined ${workspace?.name || 'the workspace'}. Redirecting...`}
        />
        <div className={styles.centered}>
          <Spinner size="md" />
        </div>
      </AuthLayout>
    );
  }

  if (state === 'declined') {
    return (
      <AuthLayout>
        <AuthHeader title="Invitation declined" subtitle="You've declined this invitation." />
        <div className={styles.centered}>
          <Button onClick={() => navigate('/')}>Go to home</Button>
        </div>
      </AuthLayout>
    );
  }

  if (state === 'error') {
    return (
      <AuthLayout>
        <AuthHeader title="Something went wrong" />
        <AuthError message={errorMessage || 'An unexpected error occurred.'} />
        <div className={styles.centered}>
          <Button onClick={handleAccept}>Try again</Button>
        </div>
      </AuthLayout>
    );
  }

  if (state === 'email-mismatch') {
    return (
      <AuthLayout>
        <AuthHeader
          title="Wrong account"
          subtitle="This invitation was sent to a different email address."
        />
        {invitation && (
          <div className={styles.inviteDetails}>
            <div className={styles.inviteRow}>
              <span className={styles.inviteLabel}>Invited email</span>
              <span className={styles.inviteValue}>{invitation.email}</span>
            </div>
            <div className={styles.inviteRow}>
              <span className={styles.inviteLabel}>Your email</span>
              <span className={styles.inviteValue}>{user?.email}</span>
            </div>
          </div>
        )}
        <AuthError message="Please sign in with the correct account to accept this invitation." />
        <div className={styles.centered}>
          <Button onClick={handleSignOut}>Sign in with different account</Button>
          <Button variant="ghost" onClick={() => navigate('/')}>Cancel</Button>
        </div>
      </AuthLayout>
    );
  }

  if (!userId) {
    return (
      <AuthLayout>
        <AuthHeader
          title="You're invited!"
          subtitle={`Join ${workspace?.name || 'a workspace'} on Δαρκ space.`}
        />
        {invitation && (
          <div className={styles.inviteDetails}>
            <div className={styles.inviteRow}>
              <span className={styles.inviteLabel}>Role</span>
              <span className={styles.inviteValue}>{invitation.role}</span>
            </div>
            <div className={styles.inviteRow}>
              <span className={styles.inviteLabel}>Sent to</span>
              <span className={styles.inviteValue}>{invitation.email}</span>
            </div>
          </div>
        )}
        <p className={styles.signinPrompt}>Sign in or create an account to accept this invitation.</p>
        <div className={styles.buttonGroup}>
          <Button onClick={() => navigate(`/signin?invite=${effectiveToken}`)}>
            Sign in
          </Button>
          <Button variant="ghost" onClick={() => navigate(`/signup?invite=${effectiveToken}`)}>
            Create account
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeader
        title="You're invited!"
        subtitle={`Join ${workspace?.name || 'a workspace'} on Δαρκ space.`}
      />
      {invitation && (
        <div className={styles.inviteDetails}>
          <div className={styles.inviteRow}>
            <span className={styles.inviteLabel}>Role</span>
            <span className={styles.inviteValue}>{invitation.role}</span>
          </div>
          <div className={styles.inviteRow}>
            <span className={styles.inviteLabel}>Sent to</span>
            <span className={styles.inviteValue}>{invitation.email}</span>
          </div>
        </div>
      )}
      <div className={styles.buttonGroup}>
        <Button onClick={handleAccept} loading={isProcessing} disabled={isProcessing}>
          Accept invitation
        </Button>
        <Button variant="ghost" onClick={handleDecline} disabled={isProcessing}>
          Decline
        </Button>
      </div>
    </AuthLayout>
  );
}
