import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';

interface LeaveWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  workspaceName: string;
  isLoading?: boolean;
}

export function LeaveWorkspaceDialog({
  open,
  onClose,
  onConfirm,
  workspaceName,
  isLoading = false,
}: LeaveWorkspaceDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Leave workspace"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={isLoading}>
            Leave workspace
          </Button>
        </>
      }
    >
      <Alert variant="warning">
        You will lose access to all channels and messages in this workspace.
      </Alert>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', marginTop: 'var(--space-4)' }}>
        Are you sure you want to leave <strong>{workspaceName}</strong>?
        You can rejoin only if invited again by a workspace admin or owner.
      </p>
    </Dialog>
  );
}
