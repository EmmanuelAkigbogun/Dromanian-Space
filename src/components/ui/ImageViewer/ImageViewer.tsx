import { useState, useEffect, useCallback } from 'react';
import { Portal } from '@/lib/overlay/Portal';
import { useFocusTrap } from '@/lib/overlay/useFocusTrap';
import { useOverlayStack } from '@/lib/overlay/useOverlayStack';
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
  const containerRef = useFocusTrap(open);
  useOverlayStack(open);

  useEffect(() => {
    if (!open) return;
    setIsLoading(true);
    setHasError(false);

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, onClose]);

  const handleLoad = useCallback(() => setIsLoading(false), []);
  const handleError = useCallback(() => { setIsLoading(false); setHasError(true); }, []);

  if (!open) return null;

  return (
    <Portal>
    <div ref={containerRef} className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true" aria-label="Image preview" tabIndex={-1}>
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
    </Portal>
  );
}
