import { useState, useEffect, useCallback } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import { getWorkspaceJoinRequests, decideWorkspaceJoinRequest } from '@/lib/workspace';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { formatRelativeTime } from '@/utils';
import type { WorkspaceJoinRequest, JoinRequestStatus } from '@/types';
import styles from './JoinRequestsList.module.css';

const STATUS_VARIANT: Record<JoinRequestStatus, 'default' | 'success' | 'error'> = {
  pending: 'default',
  accepted: 'success',
  rejected: 'error',
};

function displayName(request: WorkspaceJoinRequest): string {
  return request.requester_name || request.requester_username || 'A new user';
}

export function JoinRequestsList() {
  const { currentWorkspace } = useWorkspace();
  const { toast } = useToast();
  const [requests, setRequests] = useState<WorkspaceJoinRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);

  const fetchRequests = useCallback(async () => {
    if (!currentWorkspace) return;
    setIsLoading(true);
    const data = await getWorkspaceJoinRequests(currentWorkspace.id);
    setRequests(data);
    setIsLoading(false);
  }, [currentWorkspace]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  useEffect(() => {
    const handleUpdated = () => fetchRequests();
    window.addEventListener('join-requests-updated', handleUpdated);
    return () => window.removeEventListener('join-requests-updated', handleUpdated);
  }, [fetchRequests]);

  useEffect(() => {
    if (!currentWorkspace) return;
    const channel = supabase
      .channel(`join-requests:${currentWorkspace.id}:${Math.random().toString(36).slice(2, 9)}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'workspace_join_requests',
          filter: `workspace_id=eq.${currentWorkspace.id}`,
        },
        () => {
          fetchRequests();
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'workspace_join_requests',
          filter: `workspace_id=eq.${currentWorkspace.id}`,
        },
        () => {
          fetchRequests();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentWorkspace, fetchRequests]);

  async function handleDecide(request: WorkspaceJoinRequest, accept: boolean) {
    setActionId(request.id);
    const result = await decideWorkspaceJoinRequest(request.id, accept);
    if (result.success) {
      setRequests((prev) =>
        prev.map((r) =>
          r.id === request.id
            ? { ...r, status: accept ? 'accepted' : 'rejected', decided_at: new Date().toISOString() }
            : r,
        ),
      );
      toast({
        variant: 'success',
        description: accept
          ? `${displayName(request)} was added to the workspace.`
          : `Request from ${displayName(request)} declined.`,
      });
    } else {
      toast({ variant: 'error', description: result.error || 'Failed to update the request.' });
    }
    setActionId(null);
  }

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <Spinner size="md" />
      </div>
    );
  }

  const pending = requests.filter((r) => r.status === 'pending');
  const history = requests.filter((r) => r.status !== 'pending');

  return (
    <div>
      {pending.length === 0 && history.length === 0 && (
        <p className={styles.empty}>
          No join requests yet. Share your workspace invite link to get started.
        </p>
      )}

      {pending.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>Pending</h3>
          <ul className={styles.list}>
            {pending.map((request) => (
              <li key={request.id} className={styles.request}>
                <Avatar
                  size="md"
                  name={displayName(request)}
                  src={request.requester_avatar_url ?? undefined}
                />
                <div className={styles.requestInfo}>
                  <span className={styles.requestName}>{displayName(request)}</span>
                  <span className={styles.requestMeta}>
                    {request.requester_username ? `@${request.requester_username} · ` : ''}
                    {formatRelativeTime(request.created_at)}
                  </span>
                </div>
                <div className={styles.requestActions}>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleDecide(request, true)}
                    loading={actionId === request.id}
                    disabled={actionId !== null}
                  >
                    Accept
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleDecide(request, false)}
                    loading={actionId === request.id}
                    disabled={actionId !== null}
                  >
                    Reject
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
            {history.map((request) => (
              <li key={request.id} className={styles.request}>
                <Avatar
                  size="md"
                  name={displayName(request)}
                  src={request.requester_avatar_url ?? undefined}
                />
                <div className={styles.requestInfo}>
                  <span className={styles.requestName}>{displayName(request)}</span>
                  <span className={styles.requestMeta}>
                    {request.requester_username ? `@${request.requester_username} · ` : ''}
                    {formatRelativeTime(request.decided_at ?? request.created_at)}
                  </span>
                </div>
                <Badge variant={STATUS_VARIANT[request.status]}>{request.status}</Badge>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
