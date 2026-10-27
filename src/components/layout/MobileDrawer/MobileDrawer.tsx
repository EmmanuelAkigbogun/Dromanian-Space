import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { Navigation } from '@/components/navigation/Navigation';
import { WorkspaceSwitcher } from '@/components/workspace';
import { ChannelSidebar } from '@/components/layout/ChannelSidebar';
import { DmSidebar } from '@/components/dm/DmSidebar';
import { UserMenu } from '@/components/layout/UserMenu';
import { useLayout } from '@/app/providers/LayoutProvider';
import { useSwipeGesture } from '@/hooks/useTouch';
import { Portal } from '@/lib/overlay/Portal';
import { useFocusTrap } from '@/lib/overlay/useFocusTrap';
import { useOverlayStack } from '@/lib/overlay/useOverlayStack';
import styles from './MobileDrawer.module.css';

interface MobileDrawerProps {
  primaryNavigation: Array<{ to: string; icon: React.ReactNode; label: string }>;
  secondaryNavigation?: Array<{ to: string; icon: React.ReactNode; label: string }>;
}

export function MobileDrawer({ primaryNavigation, secondaryNavigation }: MobileDrawerProps) {
  const { isMobileOpen, closeMobileSidebar } = useLayout();
  const location = useLocation();
  const drawerRef = useFocusTrap(isMobileOpen);
  useOverlayStack(isMobileOpen);
  const lastPathRef = useRef(location.pathname + location.search);

  // Close the drawer whenever navigation changes the route while it is open
  useEffect(() => {
    const key = location.pathname + location.search;
    if (isMobileOpen && key !== lastPathRef.current) {
      closeMobileSidebar();
    }
    lastPathRef.current = key;
  }, [location.pathname, location.search, isMobileOpen, closeMobileSidebar]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isMobileOpen) {
        closeMobileSidebar();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isMobileOpen, closeMobileSidebar]);

  // Swipe to close gesture
  useSwipeGesture(drawerRef, {
    onSwipeLeft: closeMobileSidebar,
    threshold: 100,
  });

  return (
    <Portal>
      <div
        className={`${styles.overlay} ${isMobileOpen ? styles.overlayOpen : ''}`}
        onClick={closeMobileSidebar}
        aria-hidden="true"
      />
      <div
        ref={drawerRef}
        className={`${styles.drawer} ${isMobileOpen ? styles.drawerOpen : ''}`}
        role="dialog"
        aria-modal={isMobileOpen ? true : undefined}
        aria-hidden={!isMobileOpen}
        inert={!isMobileOpen}
        aria-label="Navigation menu"
        tabIndex={-1}
      >
        <div className={styles.drawerHeader}>
          <div className={styles.drawerLogo}>
            <div className={styles.drawerLogoIcon} aria-hidden="true">
              <span style={{ fontSize: '18px', color: 'white', lineHeight: 1 }}>❀</span>
            </div>
            <span className={styles.drawerLogoText}>Δαρκ space</span>
          </div>
          <button
            className={styles.drawerClose}
            onClick={closeMobileSidebar}
            aria-label="Close navigation menu"
            type="button"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className={styles.drawerContent}>
          <div className={styles.drawerWorkspace}>
            <WorkspaceSwitcher />
          </div>
          <ChannelSidebar />
          <DmSidebar isCollapsed={false} />
          <Navigation items={primaryNavigation} secondaryItems={secondaryNavigation} />
          <div className={styles.drawerFooter}>
            <UserMenu />
          </div>
        </div>
      </div>
    </Portal>
  );
}
