import { memo } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import styles from './BulkDeleteConfirmDialog.module.css';

interface BulkDeleteConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  count: number;
  totalCount?: number;
  isDeleting?: boolean;
}

export const BulkDeleteConfirmDialog = memo(function BulkDeleteConfirmDialog({
  open,
  onClose,
  onConfirm,
  count,
  totalCount,
  isDeleting = false,
}: BulkDeleteConfirmDialogProps) {
  const skippedCount = totalCount && totalCount > count ? totalCount - count : 0;
  return (
    <Dialog open={open} onClose={onClose}>
      <div className={styles.dialog}>
        <div className={styles.header}>
          <div className={styles.icon}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
          </div>
          <h2 className={styles.title}>Delete {count} {count === 1 ? 'message' : 'messages'}</h2>
        </div>

        <p className={styles.description}>
          Are you sure you want to delete {count} selected {count === 1 ? 'message' : 'messages'}? This action cannot be undone.
        </p>

        {skippedCount > 0 && (
          <p className={styles.note}>
            {skippedCount} {skippedCount === 1 ? 'selected message belongs' : 'selected messages belong'} to other people and won't be deleted.
          </p>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={onClose}
            disabled={isDeleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.deleteButton}
            onClick={onConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting...' : `Delete ${count}`}
          </button>
        </div>
      </div>
    </Dialog>
  );
});
