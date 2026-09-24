import { useState, type FormEvent } from 'react';
import { useChannel } from '@/hooks/useChannel';
import { useToast } from '@/components/ui/Toast';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import type { Channel } from '@/types';
import styles from './LeaveChannelDialog.module.css';

interface LeaveChannelDialogProps {
  open: boolean;
  onClose: () => void;
  channel: Channel;
}

export function LeaveChannelDialog({ open, onClose, channel }: LeaveChannelDialogProps) {
  const { leaveChannel } = useChannel();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);

    leaveChannel(channel.id)
      .then((success) => {
        if (success) {
          toast({ variant: 'success', description: `Left #${channel.name}` });
          onClose();
        } else {
          toast({ variant: 'error', description: 'Failed to leave channel' });
        }
      })
      .catch(() => {
        toast({ variant: 'error', description: 'Failed to leave channel' });
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }

  return (
    <Dialog open={open} onClose={onClose} title="Leave channel">
      <form onSubmit={handleSubmit} className={styles.form}>
        <p className={styles.message}>
          Are you sure you want to leave <strong>#{channel.name}</strong>?
          You will no longer see messages or be able to send messages in this channel.
        </p>

        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting} variant="danger">
            Leave channel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
