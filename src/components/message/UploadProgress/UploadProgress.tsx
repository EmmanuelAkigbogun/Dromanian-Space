import { memo } from 'react';
import { formatFileSize } from '@/lib/message';
import styles from './UploadProgress.module.css';

interface UploadFile {
  id: string;
  file: File;
  progress: number;
  status: 'uploading' | 'complete' | 'error';
  error?: string;
}

interface UploadProgressProps {
  files: UploadFile[];
  onRemove: (id: string) => void;
}

export const UploadProgress = memo(function UploadProgress({ files, onRemove }: UploadProgressProps) {
  if (files.length === 0) return null;

  return (
    <div className={styles.container}>
      {files.map((f) => (
        <div
          key={f.id}
          className={`${styles.item} ${f.status === 'error' ? styles.itemError : ''}`}
        >
          <div className={styles.fileInfo}>
            <span className={styles.fileName}>{f.file.name}</span>
            <span className={styles.fileSize}>{formatFileSize(f.file.size)}</span>
          </div>

          {f.status === 'uploading' && (
            <div className={styles.progressWrapper}>
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${f.progress}%` }}
                />
              </div>
              <span className={styles.progressText}>{f.progress}%</span>
            </div>
          )}

          {f.status === 'complete' && (
            <span className={styles.completeIcon}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          )}

          {f.status === 'error' && (
            <span className={styles.errorText}>{f.error ?? 'Failed'}</span>
          )}

          <button
            type="button"
            className={styles.removeButton}
            onClick={() => onRemove(f.id)}
            title="Remove"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
});
