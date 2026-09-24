import { memo, useCallback } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';
import styles from './TaskViewToggle.module.css';

interface TaskViewToggleProps {
  view: 'list' | 'board';
  onChange: (view: 'list' | 'board') => void;
}

export const TaskViewToggle = memo(function TaskViewToggle({ view, onChange }: TaskViewToggleProps) {
  const handleList = useCallback(() => onChange('list'), [onChange]);
  const handleBoard = useCallback(() => onChange('board'), [onChange]);

  return (
    <div className={styles.toggle}>
      <Tooltip content="List view">
        <button
          type="button"
          className={`${styles.toggleButton} ${view === 'list' ? styles.toggleButtonActive : ''}`}
          onClick={handleList}
          aria-pressed={view === 'list'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </button>
      </Tooltip>
      <div className={styles.toggleSeparator} />
      <Tooltip content="Board view">
        <button
          type="button"
          className={`${styles.toggleButton} ${view === 'board' ? styles.toggleButtonActive : ''}`}
          onClick={handleBoard}
          aria-pressed={view === 'board'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
});
