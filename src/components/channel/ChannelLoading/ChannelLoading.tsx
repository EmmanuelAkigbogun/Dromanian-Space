import { Spinner } from '@/components/ui/Spinner';
import styles from './ChannelLoading.module.css';

export function ChannelLoading() {
  return (
    <div className={styles.container}>
      <Spinner size="lg" label="Loading channel..." />
      <p className={styles.text}>Loading channel...</p>
    </div>
  );
}
