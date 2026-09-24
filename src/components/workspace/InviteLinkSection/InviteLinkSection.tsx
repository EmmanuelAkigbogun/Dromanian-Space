import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useToast } from '@/components/ui/Toast';
import { canInviteMembers } from '@/lib/workspace/permissions';
import {
  getWorkspaceInviteLinks,
  createWorkspaceInviteLink,
  revokeWorkspaceInviteLink,
} from '@/lib/workspace';
import type { WorkspaceInviteLink } from '@/types';
import styles from './InviteLinkSection.module.css';

function buildInviteUrl(token: string): string {
  return `${window.location.origin}/join/${token}`;
}

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return 'Never expires';
  const expiry = new Date(expiresAt);
  const days = Math.ceil((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'Expired';
  if (days === 1) return 'Expires tomorrow';
  return `Expires in ${days} days`;
}

export function InviteLinkSection() {
  const { currentWorkspace, currentRole } = useWorkspace();
  const { toast } = useToast();
  const [links, setLinks] = useState<WorkspaceInviteLink[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const canManage = canInviteMembers(currentRole);

  const fetchLinks = useCallback(async () => {
    if (!currentWorkspace) return;
    setIsLoading(true);
    const data = await getWorkspaceInviteLinks(currentWorkspace.id);
    setLinks(data);
    setIsLoading(false);
  }, [currentWorkspace]);

  useEffect(() => {
    fetchLinks();
  }, [fetchLinks]);

  const handleCreate = useCallback(async () => {
    if (!currentWorkspace || isCreating) return;
    setIsCreating(true);
    const result = await createWorkspaceInviteLink(currentWorkspace.id);
    if (result.success && result.link) {
      setLinks((prev) => [result.link as WorkspaceInviteLink, ...prev]);
      toast({ variant: 'success', description: 'Invite link created.' });
    } else {
      toast({ variant: 'error', description: result.error || 'Failed to create invite link.' });
    }
    setIsCreating(false);
  }, [currentWorkspace, isCreating, toast]);

  const handleCopy = useCallback(async (link: WorkspaceInviteLink) => {
    const url = buildInviteUrl(link.token);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(link.id);
      setTimeout(() => setCopiedId((prev) => (prev === link.id ? null : prev)), 2000);
      toast({ variant: 'success', description: 'Invite link copied.' });
    } catch {
      toast({ variant: 'error', description: 'Failed to copy invite link.' });
    }
  }, [toast]);

  const handleRevoke = useCallback(async (link: WorkspaceInviteLink) => {
    setActionId(link.id);
    const result = await revokeWorkspaceInviteLink(link.id);
    if (result.success) {
      setLinks((prev) => prev.filter((l) => l.id !== link.id));
      toast({ variant: 'success', description: 'Invite link revoked.' });
    } else {
      toast({ variant: 'error', description: result.error || 'Failed to revoke invite link.' });
    }
    setActionId(null);
  }, [toast]);

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h3 className={styles.sectionTitle}>Invite link</h3>
          <p className={styles.sectionHint}>
            Share a link so people can request to join this workspace. Requests need your approval.
          </p>
        </div>
        {canManage && (
          <Button
            size="sm"
            variant="secondary"
            loading={isCreating}
            disabled={isCreating}
            onClick={handleCreate}
          >
            Create invite link
          </Button>
        )}
      </div>

      {isLoading ? (
        <p className={styles.empty}>Loading invite links...</p>
      ) : links.length === 0 ? (
        <p className={styles.empty}>No active invite links.</p>
      ) : (
        <ul className={styles.list}>
          {links.map((link) => (
            <li key={link.id} className={styles.linkRow}>
              <div className={styles.linkInfo}>
                <span className={styles.linkUrl}>{buildInviteUrl(link.token)}</span>
                <span className={styles.linkExpiry}>{formatExpiry(link.expires_at)}</span>
              </div>
              {canManage && (
                <div className={styles.linkActions}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCopy(link)}
                    disabled={actionId === link.id}
                  >
                    {copiedId === link.id ? 'Copied' : 'Copy'}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleRevoke(link)}
                    loading={actionId === link.id}
                    disabled={copiedId === link.id}
                  >
                    Revoke
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
