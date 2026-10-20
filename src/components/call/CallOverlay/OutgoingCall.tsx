import { useCallContext } from '@/app/providers/CallProvider/CallProvider';
import { Avatar } from '@/components/ui/Avatar/Avatar';
import { useAuth } from '@/hooks/useAuth';
import { callProfileName, useCallProfiles } from '@/hooks/useCallProfiles/useCallProfiles';
import styles from './OutgoingCall.module.css';

export function OutgoingCall() {
  const { userId } = useAuth();
  const { currentCall, participants, cancelOutgoingCall, isRingtoneBlocked, enableCallAudio } = useCallContext();
  const remoteIds = participants.filter((participant) => participant.user_id !== userId).map((participant) => participant.user_id);
  const profiles = useCallProfiles(remoteIds);
  const names = remoteIds.map((id) => callProfileName(profiles.get(id), 'Connecting…'));
  const primaryProfile = remoteIds[0] ? profiles.get(remoteIds[0]) : undefined;
  const displayName = names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ') || 'Connecting…';

  return (
    <div className={styles.container}>
      <div className={styles.ringAnimation} />
      <div className={styles.callerInfo}>
        <Avatar src={primaryProfile?.avatar_url ?? undefined} name={displayName} alt={displayName} size="xl" className={styles.avatar} />
        <h2 className={styles.title}>{displayName}</h2>
        <p className={styles.callingStatus}>Calling…</p>
        <p className={styles.subtitle}>{currentCall?.call_type === 'group' ? 'Group Call' : 'Direct Call'}</p>
      </div>
      {isRingtoneBlocked && <button type="button" className={styles.audioButton} onClick={()=>void enableCallAudio()}>Turn on call sound</button>}
      <button type="button" className={styles.cancelButton} onClick={cancelOutgoingCall} aria-label="Cancel call">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      </button>
    </div>
  );
}
