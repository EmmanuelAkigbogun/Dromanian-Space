import styles from './Divider.module.css';

interface DividerProps {
  vertical?: boolean;
  spaced?: boolean;
  className?: string;
}

export function Divider({ vertical = false, spaced = false, className }: DividerProps) {
  const classes = [styles.divider, vertical && styles.vertical, spaced && styles.spaced, className]
    .filter(Boolean)
    .join(' ');

  return <hr className={classes} role="separator" />;
}
