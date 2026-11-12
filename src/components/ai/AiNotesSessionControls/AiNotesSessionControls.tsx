import { useCallback, useState } from 'react';
import { useAiSession, type AiSession } from '@/hooks/useAiSession/useAiSession';
import { useToast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { isAiNotesRunInFlight, isAiNotesRunRetryable } from './sessionState';
import styles from './AiNotesSessionControls.module.css';

interface AiNotesSessionController {
  session: AiSession | null;
  agent: { id: string; name: string } | null;
  busy: boolean;
  cancelling: boolean;
  reviewRunning: boolean;
  reviewReady: boolean;
  reviewFailed: boolean;
  notesRunning: boolean;
  notesRetryable: boolean;
  runNextStep: () => Promise<void>;
  endSession: () => Promise<boolean>;
}

interface AiNotesSessionButtonProps {
  controller: AiNotesSessionController;
  enabled: boolean;
  canControl?: boolean;
}

interface AiNotesSessionBannerProps {
  controller: AiNotesSessionController;
  starterLabel: string;
  conversationLabel?: string;
  canControl?: boolean;
}

/**
 * Shared controller for channel and direct-message note-taking sessions. Keeping
 * the state machine here prevents the two conversation surfaces from offering
 * different review, clarification, finalization, or retry behavior.
 */
export function useAiNotesSessionController(workspaceId: string | undefined, channelId: string | undefined): AiNotesSessionController {
  const { session, agent, busy, cancelling, start, review, finish, cancel } = useAiSession(workspaceId, channelId);
  const { toast } = useToast();
  const reviewRunning = isAiNotesRunInFlight(session?.review_status ?? null);
  const reviewReady = session?.review_status === 'completed';
  const reviewFailed = isAiNotesRunRetryable(session?.review_status ?? null);
  const notesRunning = isAiNotesRunInFlight(session?.notes_status ?? null);
  const notesRetryable = isAiNotesRunRetryable(session?.notes_status ?? null);

  const runNextStep = useCallback(async () => {
    try {
      if (!session) {
        await start();
        return;
      }

      if (reviewReady || notesRetryable) {
        const result = await finish();
        if (!result) return;
        if (result.notes === 'queued') {
          toast({
            variant: 'success',
            description: `${agent?.name ?? 'The agent'} is writing the final notes. Task requests will be listed under Tasks → Approvals.`,
          });
        } else if (result.notes === 'ready') {
          toast({ variant: 'success', description: 'Final notes and task requests are ready.' });
        } else if (result.notes === 'failed') {
          toast({
            variant: 'error',
            description: `Final notes could not be started; the session is preserved. ${result.error ?? 'Try again.'}`,
          });
        } else {
          toast({ variant: 'success', description: 'Session ended. No messages were sent, so there are no notes.' });
        }
        return;
      }

      const result = await review();
      if (!result) return;
      if (result.review === 'queued') {
        toast({
          variant: 'success',
          description: `${agent?.name ?? 'The agent'} is reviewing the conversation. Answer any questions here, then finish the session when you are ready.`,
        });
      } else if (result.review === 'ready') {
        toast({ variant: 'success', description: 'The review is ready. Answer any questions in the conversation, then finish the session.' });
      } else {
        toast({ variant: 'error', description: result.error ?? 'The session review could not be started.' });
      }
    } catch (error) {
      const fallback = session
        ? reviewReady || notesRetryable
          ? 'The session could not be finished.'
          : 'The session review could not be started.'
        : 'The agent could not join this conversation.';
      toast({ variant: 'error', description: error instanceof Error ? error.message : fallback });
    }
  }, [agent?.name, finish, notesRetryable, review, reviewReady, session, start, toast]);

  const endSession = useCallback(async (): Promise<boolean> => {
    try {
      const result = await cancel();
      if (!result) return false;
      toast({
        variant: 'success',
        description: 'Notes session ended. No final notes or task requests were created.',
      });
      return true;
    } catch (error) {
      toast({
        variant: 'error',
        description: error instanceof Error ? error.message : 'The notes session could not be ended.',
      });
      return false;
    }
  }, [cancel, toast]);

  return {
    session,
    agent,
    busy,
    cancelling,
    reviewRunning,
    reviewReady,
    reviewFailed,
    notesRunning,
    notesRetryable,
    runNextStep,
    endSession,
  };
}

export function AiNotesSessionButton({ controller, enabled, canControl = true }: AiNotesSessionButtonProps) {
  const {
    session,
    agent,
    busy,
    cancelling,
    reviewRunning,
    reviewReady,
    reviewFailed,
    notesRunning,
    notesRetryable,
    runNextStep,
    endSession,
  } = controller;
  const [confirmEndOpen, setConfirmEndOpen] = useState(false);

  if (!enabled || (!session && !agent)) return null;

  const controlLocked = Boolean(session && !canControl);
  const label = controlLocked
    ? 'Notes session active'
    : notesRunning
    ? 'Writing notes…'
    : notesRetryable
      ? 'Retry final notes'
      : reviewReady
        ? 'Finish & send tasks'
        : reviewRunning
          ? 'Reviewing…'
          : reviewFailed
            ? 'Retry review'
            : session
              ? `Review with ${agent?.name ?? 'AI'}`
              : `Invite ${agent?.name ?? 'notes agent'}`;
  const ariaLabel = controlLocked
    ? 'Notes session active; only its inviter, the channel creator, or a workspace administrator can control it'
    : notesRunning
    ? 'The AI is writing final notes and task requests'
    : notesRetryable
      ? 'Retry final notes and task requests'
      : reviewReady
        ? 'Finish AI session and send task requests for approval'
        : reviewRunning
          ? 'The AI is reviewing the conversation'
          : reviewFailed
            ? 'Retry the AI conversation review'
            : session
              ? 'Review the AI session and ask clarification questions'
              : `Invite ${agent?.name ?? 'the notes agent'} to this conversation`;

  const hasKnownMessages = Boolean(
    (session?.message_count ?? 0) > 0
      || session?.review_run_id
      || session?.review_status,
  );

  const confirmEnd = async () => {
    if (await endSession()) setConfirmEndOpen(false);
  };

  return (
    <>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.button} ${session ? styles.buttonActive : ''}`}
          onClick={() => void runNextStep()}
          disabled={busy || cancelling || reviewRunning || notesRunning || controlLocked}
          aria-label={ariaLabel}
          title={controlLocked
            ? 'Only the person who invited the notes agent, the channel creator, or a workspace administrator can review or finish this session.'
            : !session
              ? `${agent?.name ?? 'The notes agent'} reads new messages, reviews its understanding with you, then prepares final notes and task requests.`
              : undefined}
        >
          {reviewReady || notesRunning || notesRetryable ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 3l1.9 5.8L20 10l-5 3.6L16.8 20 12 16.4 7.2 20 9 13.6 4 10l6.1-1.2z" />
            </svg>
          )}
          {label}
        </button>
        {session && canControl && (
          <button
            type="button"
            className={`${styles.button} ${styles.endButton}`}
            onClick={() => setConfirmEndOpen(true)}
            disabled={cancelling}
            aria-label="End notes session without creating final notes or task requests"
            title="End this notes session without creating final notes or task requests"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
            End
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirmEndOpen}
        title="End notes session?"
        message={hasKnownMessages
          ? 'End this session without creating final notes or task requests? Messages already sent will remain in the conversation.'
          : 'End this notes session? No final notes or task requests will be created.'}
        confirmLabel="End session"
        cancelLabel="Keep session"
        danger
        loading={cancelling}
        onConfirm={() => void confirmEnd()}
        onClose={() => setConfirmEndOpen(false)}
      />
    </>
  );
}

export function AiNotesSessionBanner({
  controller,
  starterLabel,
  conversationLabel = 'this conversation',
  canControl = true,
}: AiNotesSessionBannerProps) {
  const {
    session,
    agent,
    reviewRunning,
    reviewReady,
    reviewFailed,
    notesRunning,
    notesRetryable,
  } = controller;

  if (!session) return null;

  return (
    <div className={styles.banner} role="status">
      <span className={styles.dot} aria-hidden="true" />
      <span>
        {notesRunning ? (
          <>
            <strong>{agent?.name ?? 'The agent'} is writing the final notes and task requests.</strong> You can leave {conversationLabel} and return later; progress will continue in the background.
          </>
        ) : notesRetryable ? (
          <>
            <strong>Final notes did not finish.</strong> The conversation and review are preserved. Choose <strong>Retry final notes</strong> to continue.
          </>
        ) : reviewReady ? (
          <>
            <strong>This session is still open.</strong> {agent?.name ?? 'The agent'} posted its review and any clarification questions here. Answer in the conversation, then choose <strong>Finish &amp; send tasks</strong>. Task requests will appear under Tasks → Approvals.
          </>
        ) : reviewRunning ? (
          <>
            <strong>{agent?.name ?? 'The agent'} is reviewing {conversationLabel}.</strong> Messages sent after the review begins are included in the final notes, but may not affect the review currently being generated. The finish button unlocks after the review and questions are posted.
          </>
        ) : reviewFailed ? (
          <>
            <strong>The review did not finish.</strong> Your session and messages are still here. Choose <strong>Retry review</strong> to continue.
          </>
        ) : (
          <>
            <strong>{agent?.name ?? 'The agent'} is in {conversationLabel}</strong> (invited by {starterLabel}). It reads messages sent from now on. Choose <strong>Review</strong> first so you can answer its questions before the session closes.
          </>
        )}
        {!canControl && (
          <> Only the person who invited the agent, the channel creator, or a workspace administrator can review or finish this session.</>
        )}
      </span>
    </div>
  );
}
