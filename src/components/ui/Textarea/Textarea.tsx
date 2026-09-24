import { forwardRef, type TextareaHTMLAttributes } from 'react';
import styles from './Textarea.module.css';

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  required?: boolean;
  error?: string;
  helperText?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, required, error, helperText, className, id, ...props }, ref) => {
    const textareaId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
    const classes = [styles.textarea, error && styles.textareaError, className].filter(Boolean).join(' ');

    return (
      <div className={styles.textareaWrapper}>
        {label && (
          <label htmlFor={textareaId} className={styles.label}>
            {label}
            {required && <span className={styles.required}> *</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={textareaId}
          className={classes}
          aria-invalid={!!error}
          aria-describedby={error ? `${textareaId}-error` : helperText ? `${textareaId}-helper` : undefined}
          {...props}
        />
        {error && (
          <span id={`${textareaId}-error`} className={styles.errorMessage} role="alert">
            {error}
          </span>
        )}
        {!error && helperText && (
          <span id={`${textareaId}-helper`} className={styles.helperText}>
            {helperText}
          </span>
        )}
      </div>
    );
  },
);

Textarea.displayName = 'Textarea';
