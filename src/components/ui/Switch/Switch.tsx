import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import styles from './Switch.module.css';

interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  ({ label, className, id, ...props }, ref) => {
    const autoId = useId();
    const switchId = id || autoId;

    return (
      <label className={`${styles.switchWrapper} ${className || ''}`} htmlFor={switchId}>
        <input ref={ref} id={switchId} type="checkbox" className={styles.input} {...props} />
        <span className={styles.track} aria-hidden="true">
          <span className={styles.thumb} />
        </span>
        {label && <span className={styles.label}>{label}</span>}
      </label>
    );
  },
);

Switch.displayName = 'Switch';
