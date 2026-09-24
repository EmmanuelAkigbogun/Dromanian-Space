import { useState, useEffect, type FormEvent } from 'react';
import { useChannel } from '@/hooks/useChannel';
import { useToast } from '@/components/ui/Toast';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { Channel } from '@/types';
import styles from './EditChannelDialog.module.css';

interface EditChannelDialogProps {
  open: boolean;
  onClose: () => void;
  channel: Channel;
}

export function EditChannelDialog({ open, onClose, channel }: EditChannelDialogProps) {
  const { updateChannel } = useChannel();
  const { toast } = useToast();
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description ?? '');
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [isPrivate, setIsPrivate] = useState(channel.is_private);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setName(channel.name);
      setDescription(channel.description ?? '');
      setTopic(channel.topic ?? '');
      setIsPrivate(channel.is_private);
      setError('');
    }
  }, [open, channel]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setIsSubmitting(true);
    setError('');

    updateChannel(channel.id, {
      name: trimmed,
      description: description.trim() || null,
      topic: topic.trim() || null,
      is_private: isPrivate,
    })
      .then(() => {
        toast({ variant: 'success', description: 'Channel updated' });
        onClose();
      })
      .catch(() => {
        setError('Failed to update channel');
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }

  return (
    <Dialog open={open} onClose={onClose} title="Edit channel">
      <form onSubmit={handleSubmit} className={styles.form}>
        <Input
          label="Channel name"
          placeholder="e.g. general"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          required
        />

        <Input
          label="Description (optional)"
          placeholder="What's this channel about?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <Input
          label="Topic (optional)"
          placeholder="e.g. Company announcements"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />

        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
          />
          <span>Private channel</span>
        </label>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting}>
            Save changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
