import type { HTMLAttributes } from 'react';
import styles from './Badge.module.css';

type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';
type BadgeSize = 'sm' | 'md' | 'lg';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
}

export function Badge({ variant = 'default', size = 'md', className, children, ...props }: BadgeProps) {
  const classes = [styles.badge, styles[variant], styles[size], className].filter(Boolean).join(' ');

  return (
    <span className={classes} {...props}>
      {children}
    </span>
  );
}
