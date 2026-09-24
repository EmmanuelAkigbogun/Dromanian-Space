import { forwardRef, type InputHTMLAttributes } from 'react';
import styles from './Input.module.css';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  required?: boolean;
  error?: string;
  helperText?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, required, error, helperText, className, id, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
    const classes = [styles.input, error && styles.inputError, className].filter(Boolean).join(' ');

    return (
      <div className={styles.inputWrapper}>
        {label && (
          <label htmlFor={inputId} className={styles.label}>
            {label}
            {required && <span className={styles.required}> *</span>}
          </label>
        )}
        <input ref={ref} id={inputId} className={classes} aria-invalid={!!error} aria-describedby={error ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined} {...props} />
        {error && (
          <span id={`${inputId}-error`} className={styles.errorMessage} role="alert">
            {error}
          </span>
        )}
        {!error && helperText && (
          <span id={`${inputId}-helper`} className={styles.helperText}>
            {helperText}
          </span>
        )}
      </div>
    );
  },
);

Input.displayName = 'Input';
