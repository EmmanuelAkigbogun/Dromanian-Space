import { useState, useCallback } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useTasks } from '@/hooks/useTasks';
import { TaskDialog } from '@/components/tasks/TaskDialog';
import type { Message } from '@/types';
import styles from './MessageToTaskButton.module.css';

interface MessageToTaskButtonProps {
  message: Message;
  workspaceId: string;
  onClose?: () => void;
}

export function MessageToTaskButton({ message, workspaceId, onClose }: MessageToTaskButtonProps) {
  const { toast } = useToast();
  const { convertMessageToTask } = useTasks();
  const [showDialog, setShowDialog] = useState(false);

  const handleClick = useCallback(() => {
    setShowDialog(true);
    onClose?.();
  }, [onClose]);

  const handleClose = useCallback(() => {
    setShowDialog(false);
  }, []);

  return (
    <>
      <button
        type="button"
        className={styles.button}
        onClick={handleClick}
      >
        <svg className={styles.buttonIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
          <rect x="9" y="3" width="6" height="4" rx="1" />
          <path d="M9 14l2 2 4-4" />
        </svg>
        Convert to Task
      </button>

      {showDialog && (
        <TaskDialog
          open={showDialog}
          onClose={handleClose}
          workspaceId={workspaceId}
          defaultTitle={message.content.slice(0, 200)}
          defaultDescription={message.content}
          defaultLinkedMessageId={message.id}
        />
      )}
    </>
  );
}
