import { Navigation } from '@/components/navigation/Navigation';
import { WorkspaceSwitcher } from '@/components/workspace';
import { ChannelSidebar } from '@/components/layout/ChannelSidebar';
import { DmSidebar } from '@/components/dm/DmSidebar';
import { UserMenu } from '@/components/layout/UserMenu';
import { useLayout } from '@/app/providers/LayoutProvider';
import { useIsTablet } from '@/hooks/useBreakpoint';
import styles from './Sidebar.module.css';

interface SidebarProps {
  primaryNavigation: Array<{ to: string; icon: React.ReactNode; label: string }>;
  secondaryNavigation?: Array<{ to: string; icon: React.ReactNode; label: string }>;
}

export function Sidebar({ primaryNavigation, secondaryNavigation }: SidebarProps) {
  const { isExpanded, toggleSidebar } = useLayout();
  const isTablet = useIsTablet();

  // On tablet, always show collapsed state
  const collapsed = isTablet || !isExpanded;

  return (
    <aside
      className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : styles.sidebarExpanded}`}
      aria-label="Sidebar"
    >
      <div className={styles.sidebarHeader}>
        <div className={styles.sidebarLogo}>
          <div className={styles.sidebarLogoIcon} aria-hidden="true">
            <span style={{ fontSize: '18px', color: 'white', lineHeight: 1 }}>❀</span>
          </div>
          {isExpanded && <span className={styles.sidebarLogoText}>Δαρκ space</span>}
        </div>
        {!isTablet && (
          <button
            className={styles.sidebarToggle}
            onClick={toggleSidebar}
            aria-label={isExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
            type="button"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        )}
      </div>

      <div className={styles.sidebarContent}>
        <div className={styles.sidebarWorkspace}>
          <WorkspaceSwitcher collapsed={collapsed} />
        </div>
        <ChannelSidebar collapsed={collapsed} />
        <DmSidebar isCollapsed={collapsed} />
        <Navigation items={primaryNavigation} secondaryItems={secondaryNavigation} collapsed={collapsed} />
      </div>

      <div className={styles.sidebarFooter}>
        <UserMenu collapsed={collapsed} />
      </div>
    </aside>
  );
}
