import styles from './DraftsIndicator.module.css';

interface DraftsIndicatorProps {
  hasDraft: boolean;
  className?: string;
}

export function DraftsIndicator({ hasDraft, className }: DraftsIndicatorProps) {
  if (!hasDraft) return null;

  const classes = [styles.indicator, className].filter(Boolean).join(' ');

  return (
    <span className={classes} title="You have an unsaved draft">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    </span>
  );
}
