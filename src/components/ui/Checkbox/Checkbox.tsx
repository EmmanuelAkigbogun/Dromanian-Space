import { forwardRef, type InputHTMLAttributes } from 'react';
import styles from './Checkbox.module.css';

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string;
  description?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, description, className, id, ...props }, ref) => {
    const checkboxId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <label className={`${styles.checkboxWrapper} ${className || ''}`} htmlFor={checkboxId}>
        <input ref={ref} id={checkboxId} type="checkbox" className={styles.input} {...props} />
        <span className={styles.box} aria-hidden="true">
          <svg className={styles.checkIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
        <span>
          {label && <span className={styles.label}>{label}</span>}
          {description && <div className={styles.description}>{description}</div>}
        </span>
      </label>
    );
  },
);

Checkbox.displayName = 'Checkbox';
