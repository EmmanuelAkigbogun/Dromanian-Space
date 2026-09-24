import { useState } from 'react';
import { useChannel } from '@/hooks/useChannel';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import styles from './JoinChannelButton.module.css';

interface JoinChannelButtonProps {
  channelId: string;
  channelName: string;
  variant?: 'inline' | 'card';
}

export function JoinChannelButton({ channelId, channelName, variant = 'inline' }: JoinChannelButtonProps) {
  const { joinChannel } = useChannel();
  const { toast } = useToast();
  const [isJoining, setIsJoining] = useState(false);

  async function handleJoin(e: React.MouseEvent) {
    e.stopPropagation();
    setIsJoining(true);

    const success = await joinChannel(channelId);
    if (success) {
      toast({ variant: 'success', description: `Joined #${channelName}` });
    } else {
      toast({ variant: 'error', description: 'Failed to join channel' });
    }

    setIsJoining(false);
  }

  return (
    <Button
      variant="primary"
      size="sm"
      loading={isJoining}
      onClick={handleJoin}
      className={variant === 'card' ? styles.cardButton : undefined}
    >
      Join
    </Button>
  );
}
