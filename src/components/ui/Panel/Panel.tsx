import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Panel.module.css';

interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  noPadding?: boolean;
}

export function Panel({ noPadding = false, className, children, ...props }: PanelProps) {
  const classes = [styles.panel, noPadding && styles.noPadding, className].filter(Boolean).join(' ');

  return (
    <div className={classes} {...props}>
      {children}
    </div>
  );
}

interface PanelHeaderProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  action?: ReactNode;
}

export function PanelHeader({ title, action, className, children, ...props }: PanelHeaderProps) {
  return (
    <div className={`${styles.header} ${className || ''}`} {...props}>
      {title && <h3 className={styles.title}>{title}</h3>}
      {action}
      {children}
    </div>
  );
}

export function PanelBody({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`${styles.body} ${className || ''}`} {...props}>
      {children}
    </div>
  );
}
