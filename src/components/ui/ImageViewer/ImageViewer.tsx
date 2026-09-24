import { useState, useEffect, useCallback } from 'react';
import styles from './ImageViewer.module.css';

interface ImageViewerProps {
  src: string;
  alt?: string;
  open: boolean;
  onClose: () => void;
}

export function ImageViewer({ src, alt, open, onClose }: ImageViewerProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIsLoading(true);
    setHasError(false);

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  const handleLoad = useCallback(() => setIsLoading(false), []);
  const handleError = useCallback(() => { setIsLoading(false); setHasError(true); }, []);

  if (!open) return null;

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-label="Image preview">
      <div className={styles.content} onClick={(e) => e.stopPropagation()}>
        {isLoading && (
          <div className={styles.loading}>
            <span className={styles.spinner}>❀</span>
          </div>
        )}
        {hasError ? (
          <div className={styles.error}>
            <span>Failed to load image</span>
          </div>
        ) : (
          <img
            src={src}
            alt={alt || 'Image preview'}
            className={styles.image}
            onLoad={handleLoad}
            onError={handleError}
          />
        )}
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
