import { useCallContext } from '@/app/providers/CallProvider/CallProvider';
import styles from './IncomingCall.module.css';

export function IncomingCall() {
  const { currentCall, acceptCall, declineIncomingCall, isAccepting } = useCallContext();
  const isVideo = currentCall?.with_video ?? false;

  return (
    <div className={styles.container}>
      <div className={styles.ringAnimation} />
      <div className={styles.callerInfo}>
        <div className={styles.avatar}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {isVideo ? (
              <>
                <path d="M23 7l-7 5 7 5V7z" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </>
            ) : (
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            )}
          </svg>
        </div>
        <h2 className={styles.title}>Incoming {isVideo ? 'Video' : 'Voice'} Call</h2>
        <p className={styles.subtitle}>{currentCall?.call_type === 'group' ? 'Group Call' : currentCall?.call_type === 'channel' ? 'Channel Call' : 'Direct Call'}</p>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.declineButton} onClick={declineIncomingCall} disabled={isAccepting} aria-label="Decline call">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.acceptButton}
          onClick={() => acceptCall(isVideo)}
          disabled={isAccepting}
          aria-label={isVideo ? 'Accept call with video' : 'Accept call'}
          title={isVideo ? 'Accept with video' : 'Accept call'}
        >
          {isAccepting ? (
            <div className={styles.spinner} />
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
          )}
        </button>
        <button type="button" className={`${styles.acceptButton} ${styles.acceptVideoButton}`} onClick={() => acceptCall(true)} disabled={isAccepting} aria-label="Accept with video">
          {isAccepting ? (
            <div className={styles.spinner} />
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 7l-7 5 7 5V7z" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
