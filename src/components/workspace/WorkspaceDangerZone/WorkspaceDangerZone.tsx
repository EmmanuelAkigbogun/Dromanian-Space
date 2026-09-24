import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Dialog } from '@/components/ui/Dialog';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/Toast';
import { useNavigate } from 'react-router-dom';
import { canDeleteWorkspace } from '@/lib/workspace/permissions';
import { leaveWorkspace, getOwnerCount } from '@/lib/workspace';
import { TransferOwnershipDialog } from '@/components/workspace/TransferOwnershipDialog';
import styles from './WorkspaceDangerZone.module.css';

export function WorkspaceDangerZone() {
  const { currentWorkspace, currentRole, isOwner, deleteWorkspace } = useWorkspace();
  const { userId } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showTransferDialog, setShowTransferDialog] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [canLeave, setCanLeave] = useState(true);

  const canDelete = canDeleteWorkspace(currentRole);

  useEffect(() => {
    if (!currentWorkspace || !userId) return;
    getOwnerCount(currentWorkspace.id).then((count) => {
      if (isOwner && count <= 1) {
        setCanLeave(false);
      } else {
        setCanLeave(true);
      }
    });
  }, [currentWorkspace, userId, isOwner]);

  const handleDelete = useCallback(async () => {
    if (!currentWorkspace || confirmText !== currentWorkspace.name) return;

    setIsDeleting(true);
    try {
      await deleteWorkspace(currentWorkspace.id);
      toast({ variant: 'success', title: 'Workspace deleted', description: 'The workspace has been permanently deleted.' });
      setShowDeleteConfirm(false);
      setConfirmText('');
      navigate('/');
    } catch {
      toast({ variant: 'error', description: 'Failed to delete workspace.' });
    } finally {
      setIsDeleting(false);
    }
  }, [currentWorkspace, confirmText, deleteWorkspace, toast, navigate]);

  const handleLeave = useCallback(async () => {
    if (!currentWorkspace || !userId) return;

    setIsLeaving(true);
    try {
      const result = await leaveWorkspace(currentWorkspace.id, userId);

      if (result.success) {
        toast({ variant: 'success', title: 'Left workspace', description: 'You have left the workspace.' });
        setShowLeaveConfirm(false);
        navigate('/');
      } else {
        toast({ variant: 'error', description: result.error || 'Failed to leave workspace.' });
      }
    } catch {
      toast({ variant: 'error', description: 'Failed to leave workspace.' });
    } finally {
      setIsLeaving(false);
    }
  }, [currentWorkspace, userId, toast, navigate]);

  if (!currentWorkspace) return null;

  return (
    <div className={styles.container}>
      {isOwner && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Delete workspace</h3>
            <p className={styles.sectionDescription}>
              Permanently delete <strong>{currentWorkspace.name}</strong> and all its data.
              This action cannot be undone.
            </p>
          </div>
          <Button
            variant="danger"
            size="sm"
            disabled={!canDelete}
            onClick={() => {
              setConfirmText('');
              setShowDeleteConfirm(true);
            }}
          >
            Delete workspace
          </Button>
        </div>
      )}

      {isOwner && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Transfer ownership</h3>
            <p className={styles.sectionDescription}>
              Transfer ownership of <strong>{currentWorkspace.name}</strong> to another member.
              You will become an admin after the transfer.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowTransferDialog(true)}
          >
            Transfer ownership
          </Button>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Leave workspace</h3>
          <p className={styles.sectionDescription}>
            {canLeave ? (
              <>You will lose access to <strong>{currentWorkspace.name}</strong> unless someone invites you back.</>
            ) : (
              <>You are the only owner. Transfer ownership before leaving this workspace.</>
            )}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={!canLeave}
          onClick={() => setShowLeaveConfirm(true)}
        >
          Leave workspace
        </Button>
      </div>

      <Dialog
        open={showDeleteConfirm}
        onClose={() => {
          setShowDeleteConfirm(false);
          setConfirmText('');
        }}
        title="Delete workspace"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setShowDeleteConfirm(false);
                setConfirmText('');
              }}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={isDeleting}
              disabled={confirmText !== currentWorkspace.name}
              onClick={handleDelete}
            >
              Delete workspace
            </Button>
          </>
        }
      >
        <div className={styles.confirmContent}>
          <Alert variant="warning">
            This will permanently delete <strong>{currentWorkspace.name}</strong>,
            including all channels, messages, and files. This cannot be undone.
          </Alert>
          <p className={styles.confirmPrompt}>
            Type <strong>{currentWorkspace.name}</strong> to confirm:
          </p>
          <input
            type="text"
            className={styles.confirmInput}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={currentWorkspace.name}
            autoFocus
          />
        </div>
      </Dialog>

      <Dialog
        open={showLeaveConfirm}
        onClose={() => setShowLeaveConfirm(false)}
        title="Leave workspace"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setShowLeaveConfirm(false)}
              disabled={isLeaving}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={isLeaving}
              onClick={handleLeave}
            >
              Leave workspace
            </Button>
          </>
        }
      >
        <Alert variant="warning">
          You will lose access to all channels and messages in this workspace.
        </Alert>
        <p className={styles.confirmText} style={{ marginTop: 'var(--space-4)' }}>
          Are you sure you want to leave <strong>{currentWorkspace.name}</strong>?
          You can rejoin only if invited again by a workspace admin or owner.
        </p>
      </Dialog>

      <TransferOwnershipDialog
        open={showTransferDialog}
        onClose={() => setShowTransferDialog(false)}
      />
    </div>
  );
}
