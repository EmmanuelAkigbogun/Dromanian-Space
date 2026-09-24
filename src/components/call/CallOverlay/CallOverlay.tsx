import { useCallContext } from '@/app/providers/CallProvider/CallProvider';
import { IncomingCall } from './IncomingCall';
import { OutgoingCall } from './OutgoingCall';
import { ActiveCall } from './ActiveCall';
import styles from './CallOverlay.module.css';

export function CallOverlay() {
  const { callScreen } = useCallContext();

  if (callScreen === 'none') return null;

  return (
    <div className={styles.overlay}>
      {callScreen === 'incoming' && <IncomingCall />}
      {callScreen === 'outgoing' && <OutgoingCall />}
      {callScreen === 'active' && <ActiveCall />}
    </div>
  );
}
