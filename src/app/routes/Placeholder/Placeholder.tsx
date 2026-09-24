import styles from './Placeholder.module.css';

interface PlaceholderProps {
  title: string;
  description?: string;
}

export function Placeholder({ title, description }: PlaceholderProps) {
  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h2 className={styles.pageTitle}>{title}</h2>
        {description && <p className={styles.pageDescription}>{description}</p>}
      </div>

      <div className={styles.pageContent}>
        <div className={styles.pageCard}>
          <h3 className={styles.pageCardTitle}>Coming Soon</h3>
          <p className={styles.pageCardBody}>
            This section is under development. Check back later for updates.
          </p>
        </div>
      </div>
    </div>
  );
}
