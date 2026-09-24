import { type ReactNode } from 'react';
import styles from './Breadcrumb.module.css';

interface BreadcrumbItem {
  label: string;
  href?: string;
  onClick?: () => void;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  separator?: ReactNode;
  className?: string;
}

export function Breadcrumb({ items, separator, className }: BreadcrumbProps) {
  const defaultSeparator = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );

  return (
    <nav className={`${styles.breadcrumb} ${className || ''}`} aria-label="Breadcrumb">
      <ol style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-1)', listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((item, index) => {
          const isLast = index === items.length - 1;

          return (
            <li key={index} className={styles.item}>
              {index > 0 && <span className={styles.separator}>{separator || defaultSeparator}</span>}
              {isLast ? (
                <span className={styles.current} aria-current="page">
                  {item.label}
                </span>
              ) : item.href ? (
                <a href={item.href} className={styles.link}>
                  {item.label}
                </a>
              ) : (
                <button type="button" className={styles.link} onClick={item.onClick}>
                  {item.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
