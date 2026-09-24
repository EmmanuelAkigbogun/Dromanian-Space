import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useIsSmallScreen } from '@/hooks/useBreakpoint';
import styles from './RightPanel.module.css';

interface RightPanelProps {
  title?: string;
  children?: ReactNode;
  onClose?: () => void;
  open?: boolean;
}

export function RightPanel({ title, children, onClose, open = true }: RightPanelProps) {
  const isSmallScreen = useIsSmallScreen();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isSmallScreen || !open) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onClose) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isSmallScreen, open, onClose]);

  useEffect(() => {
    if (!isSmallScreen) return;

    if (open) {
      document.body.style.overflow = 'hidden';
      panelRef.current?.focus();
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isSmallScreen, open]);

  if (isSmallScreen) {
    return (
      <>
        <div
          className={`${styles.rightPanelOverlay} ${open ? styles.rightPanelOverlayOpen : ''}`}
          onClick={onClose}
          aria-hidden="true"
        />
        <div
          ref={panelRef}
          className={`${styles.rightPanel} ${open ? styles.rightPanelOpen : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={title || 'Side panel'}
          tabIndex={-1}
        >
          {title && (
            <div className={styles.rightPanelHeader}>
              <h2 className={styles.rightPanelTitle}>{title}</h2>
              {onClose && (
                <button
                  className={styles.rightPanelClose}
                  onClick={onClose}
                  aria-label="Close panel"
                  type="button"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          )}
          <div className={styles.rightPanelContent}>{children}</div>
        </div>
      </>
    );
  }

  return (
    <aside className={styles.rightPanel} aria-label={title || 'Side panel'}>
      {title && (
        <div className={styles.rightPanelHeader}>
          <h2 className={styles.rightPanelTitle}>{title}</h2>
          {onClose && (
            <button
              className={styles.rightPanelClose}
              onClick={onClose}
              aria-label="Close panel"
              type="button"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      )}
      <div className={styles.rightPanelContent}>{children}</div>
    </aside>
  );
}
