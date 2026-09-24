import { forwardRef, type InputHTMLAttributes } from 'react';
import styles from './Radio.module.css';

interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string;
  description?: string;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(
  ({ label, description, className, id, ...props }, ref) => {
    const radioId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <label className={`${styles.radioWrapper} ${className || ''}`} htmlFor={radioId}>
        <input ref={ref} id={radioId} type="radio" className={styles.input} {...props} />
        <span className={styles.circle} aria-hidden="true" />
        <span>
          {label && <span className={styles.label}>{label}</span>}
          {description && <div className={styles.description}>{description}</div>}
        </span>
      </label>
    );
  },
);

Radio.displayName = 'Radio';
