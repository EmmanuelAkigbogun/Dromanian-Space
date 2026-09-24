import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { AuthLayout, AuthHeader, AuthError } from '@/components/auth/AuthLayout';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { WorkspaceAvatar } from '@/components/workspace/WorkspaceAvatar';
import { useAuth } from '@/hooks/useAuth';
import { getWorkspaceInviteLinkInfo, submitWorkspaceJoinRequest } from '@/lib/workspace';
import type { WorkspaceInviteLinkInfo } from '@/types';
import styles from './JoinWorkspace.module.css';

type JoinState =
  | 'loading'
  | 'valid'
  | 'invalid'
  | 'expired'
  | 'member'
  | 'pending'
  | 'rejected'
  | 'requested'
  | 'error';

export function JoinWorkspace() {
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { userId, isLoading: authLoading } = useAuth();

  const [state, setState] = useState<JoinState>('loading');
  const [info, setInfo] = useState<WorkspaceInviteLinkInfo | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const effectiveToken = token || searchParams.get('join');

  const loadInfo = useCallback(async (tokenToLoad: string) => {
    setState('loading');
    const result = await getWorkspaceInviteLinkInfo(tokenToLoad);

    if (!result) {
      setState('invalid');
      return;
    }

    if (!result.found) {
      setState(result.reason === 'expired' ? 'expired' : 'invalid');
      return;
    }

    setInfo(result);

    if (result.is_member) {
      setState('member');
    } else if (result.request_status === 'pending') {
      setState('pending');
    } else if (result.request_status === 'rejected') {
      setState('rejected');
    } else if (!userId) {
      setState('valid');
    } else {
      setState('valid');
    }
  }, [userId]);

  useEffect(() => {
    if (authLoading) return;
    if (!effectiveToken) {
      setState('invalid');
      return;
    }
    loadInfo(effectiveToken);
  }, [authLoading, effectiveToken, loadInfo]);

  async function handleRequestToJoin() {
    if (!effectiveToken || isProcessing) return;
    setIsProcessing(true);
    setErrorMessage('');
    try {
      const result = await submitWorkspaceJoinRequest(effectiveToken);
      if (result.success) {
        setState('requested');
      } else {
        setErrorMessage(result.error || 'Failed to send your request.');
        if (result.error === 'already-member') {
          setState('member');
        } else if (result.error === 'already-requested') {
          setState('pending');
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

  if (state === 'loading' || authLoading) {
    return (
      <AuthLayout>
        <AuthHeader title="Join workspace" />
        <div className={styles.centered}>
          <Spinner size="md" />
          <p className={styles.loadingText}>Looking up the workspace...</p>
        </div>
      </AuthLayout>
    );
  }

  if (state === 'invalid') {
    return (
      <AuthLayout>
        <AuthHeader
          title="Invalid invite link"
          subtitle="This invite link is invalid or no longer exists."
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
          title="Invite link expired"
          subtitle="This invite link has expired. Please ask for a new one."
        />
        <div className={styles.centered}>
          <Button onClick={() => navigate('/signin')}>Go to sign in</Button>
        </div>
      </AuthLayout>
    );
  }

  const renderWorkspaceCard = () => (
    <div className={styles.card}>
      <WorkspaceAvatar
        name={info?.workspace_name || ''}
        avatarUrl={info?.workspace_avatar_url}
        size="lg"
      />
      <div className={styles.cardText}>
        <h2 className={styles.workspaceName}>{info?.workspace_name}</h2>
        {info?.workspace_description && (
          <p className={styles.workspaceDescription}>{info.workspace_description}</p>
        )}
      </div>
    </div>
  );

  if (state === 'member') {
    return (
      <AuthLayout>
        <AuthHeader
          title="You're already a member"
          subtitle={`You're already part of ${info?.workspace_name || 'this workspace'}.`}
        />
        {renderWorkspaceCard()}
        <div className={styles.centered}>
          <Button onClick={() => navigate('/')}>Go to workspace</Button>
        </div>
      </AuthLayout>
    );
  }

  if (state === 'pending') {
    return (
      <AuthLayout>
        <AuthHeader
          title="Request sent"
          subtitle="An owner or admin will review your request to join."
        />
        {renderWorkspaceCard()}
        <p className={styles.muted}>
          Your request to join {info?.workspace_name || 'this workspace'} is awaiting approval.
        </p>
        <div className={styles.centered}>
          <Button variant="ghost" onClick={() => navigate('/')}>Go to home</Button>
        </div>
      </AuthLayout>
    );
  }

  if (state === 'requested') {
    return (
      <AuthLayout>
        <AuthHeader
          title="Request sent"
          subtitle="An owner or admin will review your request to join."
        />
        {renderWorkspaceCard()}
        <p className={styles.muted}>
          Your request to join {info?.workspace_name || 'this workspace'} is awaiting approval.
          You&apos;ll get a notification once it&apos;s decided.
        </p>
        <div className={styles.centered}>
          <Button variant="ghost" onClick={() => navigate('/')}>Go to home</Button>
        </div>
      </AuthLayout>
    );
  }

  if (state === 'rejected') {
    return (
      <AuthLayout>
        <AuthHeader
          title="Request declined"
          subtitle="Your previous request to join was declined, but you can try again."
        />
        {renderWorkspaceCard()}
        <div className={styles.centered}>
          <Button onClick={handleRequestToJoin} loading={isProcessing} disabled={isProcessing}>
            Request to join
          </Button>
          <Button variant="ghost" onClick={() => navigate('/')}>Go to home</Button>
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
          <Button onClick={handleRequestToJoin} loading={isProcessing}>Try again</Button>
        </div>
      </AuthLayout>
    );
  }

  if (!userId) {
    return (
      <AuthLayout>
        <AuthHeader
          title="You're invited!"
          subtitle={`Join ${info?.workspace_name || 'a workspace'} on Δαρκ space.`}
        />
        {renderWorkspaceCard()}
        <p className={styles.muted}>Sign in or create an account to request access.</p>
        <div className={styles.buttonGroup}>
          <Button onClick={() => navigate(`/signin?join=${effectiveToken}`)}>
            Sign in
          </Button>
          <Button variant="ghost" onClick={() => navigate(`/signup?join=${effectiveToken}`)}>
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
        subtitle={`Join ${info?.workspace_name || 'a workspace'} on Δαρκ space.`}
      />
      {renderWorkspaceCard()}
      <p className={styles.muted}>
        Request to join {info?.workspace_name || 'this workspace'}. An owner or admin will
        review your request.
      </p>
      <div className={styles.buttonGroup}>
        <Button onClick={handleRequestToJoin} loading={isProcessing} disabled={isProcessing}>
          Request to join
        </Button>
        <Button variant="ghost" onClick={() => navigate('/')}>Cancel</Button>
      </div>
    </AuthLayout>
  );
}
