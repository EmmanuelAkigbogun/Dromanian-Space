import { useEffect, type ReactNode } from 'react';
import { Portal } from '@/lib/overlay/Portal';
import { useFocusTrap } from '@/lib/overlay/useFocusTrap';
import { useOverlayStack } from '@/lib/overlay/useOverlayStack';
import styles from './Drawer.module.css';

type DrawerPosition = 'left' | 'right' | 'top' | 'bottom';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  position?: DrawerPosition;
}

export function Drawer({ open, onClose, title, children, footer, position = 'right' }: DrawerProps) {
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
        className={styles.overlay}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'drawer-title' : undefined}
        tabIndex={-1}
        data-overlay-id={overlayId}
      >
        <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
        <div className={`${styles.drawer} ${styles[position]}`}>
          {title && (
            <div className={styles.drawerHeader}>
              <h2 id="drawer-title" className={styles.drawerTitle}>
                {title}
              </h2>
              <button
                type="button"
                className={styles.drawerClose}
                onClick={onClose}
                aria-label="Close drawer"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
          <div className={styles.drawerBody}>{children}</div>
          {footer && <div className={styles.drawerFooter}>{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}
