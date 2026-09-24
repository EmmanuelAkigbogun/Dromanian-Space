import { forwardRef, type InputHTMLAttributes } from 'react';
import styles from './SearchInput.module.css';

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  onClear?: () => void;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, onClear, value, ...props }, ref) => {
    const classes = [styles.input, className].filter(Boolean).join(' ');

    return (
      <div className={styles.searchWrapper}>
        <span className={styles.icon}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
        </span>
        <input ref={ref} type="search" className={classes} value={value} {...props} />
        {value && onClear && (
          <button type="button" className={styles.clearButton} onClick={onClear} aria-label="Clear search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    );
  },
);

SearchInput.displayName = 'SearchInput';
