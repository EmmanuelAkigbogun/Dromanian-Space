import type { ReactNode } from 'react';
import styles from './ContentArea.module.css';

interface ContentAreaProps {
  children: ReactNode;
}

export function ContentArea({ children }: ContentAreaProps) {
  return (
    <main className={styles.contentArea} role="main">
      <div className={styles.contentInner}>{children}</div>
    </main>
  );
}
