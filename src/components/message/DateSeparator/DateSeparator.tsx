import { memo } from 'react';
import styles from './DateSeparator.module.css';

interface DateSeparatorProps {
  date: string;
}

function formatDateSeparator(dateString: string): string {
  const date = new Date(dateString);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
  });
}

export const DateSeparator = memo(function DateSeparator({ date }: DateSeparatorProps) {
  return (
    <div className={styles.separator}>
      <div className={styles.line} />
      <span className={styles.text}>{formatDateSeparator(date)}</span>
      <div className={styles.line} />
    </div>
  );
});
