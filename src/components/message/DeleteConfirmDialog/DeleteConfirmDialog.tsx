import { memo } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { getDisplayName } from '@/lib/message';
import type { Message, Profile } from '@/types';
import styles from './DeleteConfirmDialog.module.css';

interface DeleteConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  message: Message;
  profile: Profile | null;
  isDeleting?: boolean;
}

export const DeleteConfirmDialog = memo(function DeleteConfirmDialog({
  open,
  onClose,
  onConfirm,
  message,
  profile,
  isDeleting = false,
}: DeleteConfirmDialogProps) {
  const displayName = getDisplayName(profile, message.user_id);

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
          <h2 className={styles.title}>Delete message</h2>
        </div>

        <p className={styles.description}>
          Are you sure you want to delete this message? This action cannot be undone.
        </p>

        <div className={styles.preview}>
          <div className={styles.previewContent}>{message.content}</div>
          <div className={styles.previewAuthor}>— {displayName}</div>
        </div>

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
            {isDeleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </Dialog>
  );
});