import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';

interface RemoveMemberConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  memberName: string;
  memberEmail: string;
  isLoading?: boolean;
}

export function RemoveMemberConfirmDialog({
  open,
  onClose,
  onConfirm,
  memberName,
  memberEmail,
  isLoading = false,
}: RemoveMemberConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Remove member"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={isLoading}>
            Remove
          </Button>
        </>
      }
    >
      <Alert variant="warning">
        This member will lose access to all workspace channels and messages.
      </Alert>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', marginTop: 'var(--space-4)' }}>
        Are you sure you want to remove <strong>{memberName}</strong> ({memberEmail}) from this workspace?
      </p>
    </Dialog>
  );
}
