import styles from './Progress.module.css';

type ProgressSize = 'sm' | 'md' | 'lg';

interface ProgressProps {
  value?: number;
  max?: number;
  size?: ProgressSize;
  indeterminate?: boolean;
  className?: string;
  label?: string;
}

export function Progress({
  value = 0,
  max = 100,
  size = 'md',
  indeterminate = false,
  className,
  label,
}: ProgressProps) {
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100);
  const classes = [styles.progress, styles[size], indeterminate && styles.indeterminate, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <div className={styles.track} style={indeterminate ? undefined : { width: `${percentage}%` }} />
    </div>
  );
}
