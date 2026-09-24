import { forwardRef, type SelectHTMLAttributes } from 'react';
import styles from './Select.module.css';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  required?: boolean;
  error?: string;
  helperText?: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, required, error, helperText, options, placeholder, className, id, ...props }, ref) => {
    const selectId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
    const selectClasses = [styles.select, error && styles.selectError, className].filter(Boolean).join(' ');

    return (
      <div className={styles.selectWrapper}>
        {label && (
          <label htmlFor={selectId} className={styles.label}>
            {label}
            {required && <span className={styles.required}> *</span>}
          </label>
        )}
        <div className={styles.selectContainer}>
          <select
            ref={ref}
            id={selectId}
            className={selectClasses}
            aria-invalid={!!error}
            aria-describedby={error ? `${selectId}-error` : helperText ? `${selectId}-helper` : undefined}
            {...props}
          >
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
          <span className={styles.arrow}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </div>
        {error && (
          <span id={`${selectId}-error`} className={styles.errorMessage} role="alert">
            {error}
          </span>
        )}
        {!error && helperText && (
          <span id={`${selectId}-helper`} className={styles.helperText}>
            {helperText}
          </span>
        )}
      </div>
    );
  },
);

Select.displayName = 'Select';
