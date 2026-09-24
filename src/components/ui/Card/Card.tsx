import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Card.module.css';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: boolean;
  hoverable?: boolean;
}

export function Card({ padding = true, hoverable = false, className, children, ...props }: CardProps) {
  const classes = [styles.card, padding && styles.padding, hoverable && styles.hoverable, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} {...props}>
      {children}
    </div>
  );
}

interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function CardHeader({ title, description, action, className, children, ...props }: CardHeaderProps) {
  return (
    <div className={`${styles.header} ${className || ''}`} {...props}>
      <div>
        <h3 className={styles.title}>{title}</h3>
        {description && <p className={styles.description}>{description}</p>}
      </div>
      {action}
      {children}
    </div>
  );
}

export function CardBody({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`${styles.body} ${className || ''}`} {...props}>
      {children}
    </div>
  );
}

export function CardFooter({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`${styles.footer} ${className || ''}`} {...props}>
      {children}
    </div>
  );
}
