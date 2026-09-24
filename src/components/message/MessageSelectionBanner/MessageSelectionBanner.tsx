import { useMessageSelection } from '@/app/providers/MessageSelectionProvider';
import styles from './MessageSelectionBanner.module.css';

export function MessageSelectionBanner() {
  const selection = useMessageSelection();

  if (selection.selectedCount === 0) return null;

  return (
    <div className={styles.selectionBanner}>
      <span>
        <strong>{selection.selectedCount}</strong> selected
      </span>
      <button
        type="button"
        className={styles.cancelButton}
        onClick={selection.clearSelection}
        aria-label="Cancel selection"
        title="Cancel selection"
      >
        ✕
      </button>
    </div>
  );
}
