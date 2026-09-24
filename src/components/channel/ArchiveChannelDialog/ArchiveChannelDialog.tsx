import { useState, type FormEvent } from 'react';
import { useChannel } from '@/hooks/useChannel';
import { useToast } from '@/components/ui/Toast';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import type { Channel } from '@/types';
import styles from './ArchiveChannelDialog.module.css';

interface ArchiveChannelDialogProps {
  open: boolean;
  onClose: () => void;
  channel: Channel;
}

export function ArchiveChannelDialog({ open, onClose, channel }: ArchiveChannelDialogProps) {
  const { archiveChannel, restoreChannel } = useChannel();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const isArchived = !!channel.archived_at;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setError('');

    const action = isArchived ? restoreChannel(channel.id) : archiveChannel(channel.id);

    action
      .then(() => {
        toast({
          variant: 'success',
          description: isArchived ? 'Channel restored' : 'Channel archived',
        });
        onClose();
      })
      .catch(() => {
        setError(isArchived ? 'Failed to restore channel' : 'Failed to archive channel');
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }

  return (
    <Dialog open={open} onClose={onClose} title={isArchived ? 'Restore channel' : 'Archive channel'}>
      <form onSubmit={handleSubmit} className={styles.form}>
        <p className={styles.description}>
          {isArchived ? (
            <>Restore <strong>#{channel.name}</strong>? It will become visible to workspace members again.</>
          ) : (
            <>Archive <strong>#{channel.name}</strong>? It will be hidden from the channel list but can be restored later.</>
          )}
        </p>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting}>
            {isArchived ? 'Restore channel' : 'Archive channel'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
