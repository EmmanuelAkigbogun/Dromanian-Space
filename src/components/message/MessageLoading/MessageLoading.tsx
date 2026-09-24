import styles from './MessageLoading.module.css';

export function MessageLoading() {
  return (
    <div className={styles.container}>
      {[1, 2, 3].map((i) => (
        <div key={i} className={styles.skeleton}>
          <div className={styles.avatarSkeleton} />
          <div className={styles.contentSkeleton}>
            <div className={styles.lineSkeleton} style={{ width: '120px' }} />
            <div className={styles.lineSkeleton} style={{ width: '280px' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
