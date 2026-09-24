import styles from './Spinner.module.css';

type SpinnerSize = 'sm' | 'md' | 'lg';
type SpinnerColor = 'primary' | 'secondary' | 'inverse';

interface SpinnerProps {
  size?: SpinnerSize;
  color?: SpinnerColor;
  className?: string;
  label?: string;
}

export function Spinner({ size = 'md', color = 'primary', className, label = 'Loading...' }: SpinnerProps) {
  const classes = [styles.spinner, styles[size], styles[color], className].filter(Boolean).join(' ');

  return (
    <div className={classes} role="status" aria-label={label}>
      <span className={styles.icon}>❀</span>
    </div>
  );
}
