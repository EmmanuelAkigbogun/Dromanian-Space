import { useState, type FormEvent } from 'react';
import { useChannel } from '@/hooks/useChannel';
import { useToast } from '@/components/ui/Toast';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import type { Channel } from '@/types';
import styles from './DeleteChannelDialog.module.css';

interface DeleteChannelDialogProps {
  open: boolean;
  onClose: () => void;
  channel: Channel;
}

export function DeleteChannelDialog({ open, onClose, channel }: DeleteChannelDialogProps) {
  const { deleteChannel } = useChannel();
  const { toast } = useToast();
  const [confirmText, setConfirmText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const isConfirmed = confirmText === channel.name;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isConfirmed) return;

    setIsSubmitting(true);
    setError('');

    deleteChannel(channel.id)
      .then(() => {
        toast({ variant: 'success', description: 'Channel deleted' });
        setConfirmText('');
        onClose();
      })
      .catch(() => {
        setError('Failed to delete channel');
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }

  function handleClose() {
    setConfirmText('');
    setError('');
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} title="Delete channel">
      <form onSubmit={handleSubmit} className={styles.form}>
        <p className={styles.warning}>
          Are you sure you want to delete <strong>#{channel.name}</strong>?
          This action cannot be undone. All messages will be permanently deleted.
        </p>

        <div className={styles.confirmField}>
          <label className={styles.confirmLabel}>
            Type <strong>#{channel.name}</strong> to confirm
          </label>
          <input
            type="text"
            className={styles.confirmInput}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={`#${channel.name}`}
            autoFocus
          />
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting} disabled={!isConfirmed} variant="danger">
            Delete channel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
