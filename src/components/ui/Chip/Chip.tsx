import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Chip.module.css';

interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  active?: boolean;
  icon?: ReactNode;
  onRemove?: () => void;
}

export function Chip({ active = false, icon, onRemove, className, children, ...props }: ChipProps) {
  const classes = [styles.chip, active && styles.active, className].filter(Boolean).join(' ');

  return (
    <span className={classes} {...props}>
      {icon && <span className={styles.icon}>{icon}</span>}
      {children}
      {onRemove && (
        <button
          type="button"
          className={styles.removeButton}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Remove"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </span>
  );
}
