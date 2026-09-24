import { Spinner } from '@/components/ui/Spinner';
import styles from './WorkspaceLoading.module.css';

export function WorkspaceLoading() {
  return (
    <div className={styles.container}>
      <Spinner size="lg" />
      <p className={styles.text}>Loading workspace...</p>
    </div>
  );
}
