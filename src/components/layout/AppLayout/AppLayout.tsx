import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Sidebar } from '../Sidebar';
import { Header } from '../Header';
import { ContentArea } from '../ContentArea';
import { RightPanel } from '../RightPanel';
import { MobileDrawer } from '../MobileDrawer';
import { useLayout } from '@/app/providers/LayoutProvider';
import { useIsTablet } from '@/hooks/useBreakpoint';
import styles from './AppLayout.module.css';

interface NavigationItem {
  to: string;
  icon: React.ReactNode;
  label: string;
}

interface AppLayoutProps {
  children: ReactNode;
  primaryNavigation: NavigationItem[];
  secondaryNavigation?: NavigationItem[];
  headerTitle?: string;
  rightPanelTitle?: string;
  rightPanelContent?: ReactNode;
  onRightPanelClose?: () => void;
}

export function AppLayout({
  children,
  primaryNavigation,
  secondaryNavigation,
  headerTitle,
  rightPanelTitle,
  rightPanelContent,
  onRightPanelClose,
}: AppLayoutProps) {
  const { isExpanded } = useLayout();
  const isTablet = useIsTablet();

  // On tablet, always treat as collapsed
  const collapsed = isTablet || !isExpanded;

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let lastHeight = vv.height;
    let savedScroll: { x: number; y: number } | null = null;
    let keyboardOpen = false;

    const saveScroll = () => {
      savedScroll = { x: window.scrollX, y: window.scrollY };
    };

    const onResize = () => {
      if (vv.height < lastHeight) {
        if (!keyboardOpen) saveScroll();
        keyboardOpen = true;
      } else if (vv.height > lastHeight && keyboardOpen) {
        keyboardOpen = false;
        const target = savedScroll;
        savedScroll = null;
        if (target) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              window.scrollTo(target.x, target.y);
            });
          });
        }
      }
      lastHeight = vv.height;
    };

    const onScroll = () => {
      if (keyboardOpen) saveScroll();
    };

    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onScroll);
    return () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onScroll);
    };
  }, []);

  return (
    <div className={styles.appLayout}>
      <div
        className={`${styles.appLayoutSidebar} ${collapsed ? styles.appLayoutSidebarCollapsed : styles.appLayoutSidebarExpanded}`}
      >
        <Sidebar primaryNavigation={primaryNavigation} secondaryNavigation={secondaryNavigation} />
      </div>

      <div className={styles.appLayoutMain}>
        <Header title={headerTitle} />

        <div className={styles.appLayoutContent}>
          <ContentArea>{children}</ContentArea>

          {rightPanelContent && (
            <RightPanel title={rightPanelTitle} onClose={onRightPanelClose}>
              {rightPanelContent}
            </RightPanel>
          )}
        </div>
      </div>

      <MobileDrawer primaryNavigation={primaryNavigation} secondaryNavigation={secondaryNavigation} />
    </div>
  );
}
