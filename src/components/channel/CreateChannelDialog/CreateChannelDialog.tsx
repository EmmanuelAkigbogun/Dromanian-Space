import { useState, type FormEvent } from 'react';
import { useChannel } from '@/hooks/useChannel';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import styles from './CreateChannelDialog.module.css';

interface CreateChannelDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateChannelDialog({ open, onClose }: CreateChannelDialogProps) {
  const { createChannel } = useChannel();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  function toSlug(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setIsSubmitting(true);
    setError('');

    createChannel(trimmed, toSlug(trimmed), {
      description: description.trim() || undefined,
      topic: topic.trim() || undefined,
      isPrivate,
    })
      .then(() => {
        setName('');
        setDescription('');
        setTopic('');
        setIsPrivate(false);
        onClose();
      })
      .catch(() => {
        setError('Failed to create channel');
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }

  return (
    <Dialog open={open} onClose={onClose} title="Create channel">
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
            Create channel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
