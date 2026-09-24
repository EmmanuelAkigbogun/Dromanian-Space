import styles from './WorkspaceError.module.css';

interface WorkspaceErrorProps {
  message?: string;
}

export function WorkspaceError({ message = 'Something went wrong loading your workspace.' }: WorkspaceErrorProps) {
  return (
    <div className={styles.container}>
      <div className={styles.icon}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
      </div>
      <h2 className={styles.title}>Workspace error</h2>
      <p className={styles.message}>{message}</p>
      <button
        className={styles.button}
        onClick={() => window.location.reload()}
        type="button"
      >
        Try again
      </button>
    </div>
  );
}
