import { useCallback, useState } from 'react';
import { useMessageSelection } from '@/app/providers/MessageSelectionProvider';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/Toast';
import { deleteMessage, getCurrentForwardedAttachmentPolicy } from '@/lib/message';
import type { ForwardedAttachmentPolicy } from '@/lib/message/attachment';

export function useBulkMessageActions() {
  const selection = useMessageSelection();
  const { toast } = useToast();
  const { userId } = useAuth();
  const [forwardOpen, setForwardOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const deletableCount = selection.selectedMessages.filter((m) => m.user_id === userId).length;

  const openBulkForward = useCallback(() => {
    setForwardOpen(true);
  }, []);

  const closeBulkForward = useCallback(() => {
    setForwardOpen(false);
  }, []);

  const openBulkDelete = useCallback(() => {
    if (selection.selectedMessages.some((m) => m.user_id === userId)) {
      setDeleteOpen(true);
    } else {
      toast({
        description: 'You can only delete messages you sent.',
        variant: 'error',
      });
    }
  }, [selection.selectedMessages, userId, toast]);

  const closeBulkDelete = useCallback(() => {
    if (!isDeleting) setDeleteOpen(false);
  }, [isDeleting]);

  const deleteSelected = useCallback(async () => {
    const messages = selection.selectedMessages.filter((m) => m.user_id === userId);
    if (messages.length === 0) return;
    setIsDeleting(true);
    try {
      // Fetch the attachment policy once (never per-message, and never through
      // supabase.auth.getUser()) so a bulk delete can't trigger the auth
      // token-refresh race that randomly signs the user out.
      let policy: ForwardedAttachmentPolicy = 'keep';
      if (userId) policy = await getCurrentForwardedAttachmentPolicy(userId);
      const results = await Promise.all(messages.map((m) => deleteMessage(m.id, { userId: userId ?? undefined, policy })));
      const ok = results.filter(Boolean).length;
      if (ok > 0) {
        toast({
          description: `Deleted ${ok} ${ok === 1 ? 'message' : 'messages'}`,
          variant: 'success',
        });
      } else {
        toast({ description: 'Failed to delete messages', variant: 'error' });
      }
      selection.clearSelection();
      setDeleteOpen(false);
    } finally {
      setIsDeleting(false);
    }
  }, [selection, toast, userId]);

  return {
    selectedCount: selection.selectedCount,
    selectedMessages: selection.selectedMessages,
    deletableCount,
    clearSelection: selection.clearSelection,
    forwardOpen,
    openBulkForward,
    closeBulkForward,
    deleteOpen,
    openBulkDelete,
    closeBulkDelete,
    deleteSelected,
    isDeleting,
  };
}
