import { useEffect, type ReactNode } from 'react';
import { Portal } from '@/lib/overlay/Portal';
import { useFocusTrap } from '@/lib/overlay/useFocusTrap';
import { useOverlayStack } from '@/lib/overlay/useOverlayStack';
import styles from './Dialog.module.css';

type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
}

export function Dialog({ open, onClose, title, children, footer, size = 'md' }: DialogProps) {
  const overlayId = useOverlayStack(open);
  const containerRef = useFocusTrap(open);

  useEffect(() => {
    if (!open) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <Portal>
      <div
        ref={containerRef}
        className={`${styles.overlay} ${styles[size]}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'dialog-title' : undefined}
        tabIndex={-1}
        data-overlay-id={overlayId}
      >
        <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
        <div className={styles.dialog}>
          {title && (
            <div className={styles.dialogHeader}>
              <h2 id="dialog-title" className={styles.dialogTitle}>
                {title}
              </h2>
              <button
                type="button"
                className={styles.dialogClose}
                onClick={onClose}
                aria-label="Close dialog"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
          <div className={styles.dialogBody}>{children}</div>
          {footer && <div className={styles.dialogFooter}>{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}
