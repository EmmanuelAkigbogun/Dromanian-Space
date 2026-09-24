import { memo } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import styles from './RemoveEmbedConfirmDialog.module.css';

interface RemoveEmbedConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  url: string;
  isRemoving?: boolean;
}

export const RemoveEmbedConfirmDialog = memo(function RemoveEmbedConfirmDialog({
  open,
  onClose,
  onConfirm,
  url,
  isRemoving = false,
}: RemoveEmbedConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose}>
      <div className={styles.dialog}>
        <div className={styles.header}>
          <div className={styles.icon}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="9" x2="15" y2="15" />
              <line x1="15" y1="9" x2="9" y2="15" />
            </svg>
          </div>
          <h2 className={styles.title}>Remove embed</h2>
        </div>

        <p className={styles.description}>
          Are you sure you want to remove this embed? The link will still appear as plain text in the message.
        </p>

        <div className={styles.preview}>
          <div className={styles.previewUrl}>{url}</div>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={onClose}
            disabled={isRemoving}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.removeButton}
            onClick={onConfirm}
            disabled={isRemoving}
          >
            {isRemoving ? 'Removing...' : 'Remove'}
          </button>
        </div>
      </div>
    </Dialog>
  );
});
