import type { ReactNode } from 'react';
import { useLocation, NavLink } from 'react-router-dom';
import { WorkspaceSwitcher } from '@/components/workspace';
import { ChannelSidebar } from '@/components/layout/ChannelSidebar';
import { DmSidebar } from '@/components/dm/DmSidebar';
import { UserMenu } from '@/components/layout/UserMenu';
import { useLayout } from '@/app/providers/LayoutProvider';
import { useIsTablet } from '@/hooks/useBreakpoint';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useFeatureAccess } from '@/lib/workspace/features';
import { BellIcon, SettingsIcon } from '@/components/shared/Icons';
import styles from './Sidebar.module.css';

interface NavEntry {
  to: string;
  icon: ReactNode;
  label: string;
}

interface SidebarProps {
  primaryNavigation: NavEntry[];
  secondaryNavigation?: NavEntry[];
}

/** Small line icons for submenu entries (16px, stroke follows text color). */
const GLYPHS: Record<string, ReactNode> = {
  overview: <path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" />,
  tasks: <path d="M9 11l3 3 8-8M20 12v7a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2h9" />,
  projects: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  calendar: <path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z" />,
  channels: <path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" />,
  threads: <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />,
  mentions: <path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-4 8M16 12a4 4 0 11-8 0 4 4 0 018 0z" />,
  saved: <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  user: <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" />,
  share: <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />,
  clock: <path d="M12 7v5l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />,
  star: <path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8l-5.8 3.1 1.1-6.5L2.6 9.8l6.5-.9z" />,
  trash: <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />,
  agents: <path d="M12 3l1.9 5.8L20 10l-5 3.6L16.8 20 12 16.4 7.2 20 9 13.6 4 10l6.1-1.2z" />,
  team: <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />,
  building: <path d="M3 21h18M5 21V5a2 2 0 012-2h10a2 2 0 012 2v16M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" />,
  deal: <path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />,
  more: <path d="M12 5v.01M12 12v.01M12 19v.01" />,
};

function Glyph({ name }: { name: string }) {
  return (
    <svg className={styles.glyph} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[name] ?? GLYPHS.more}
    </svg>
  );
}

type Section = 'chat' | 'drive' | 'agents' | 'crm' | 'workspace';

const SECTION_TITLES: Record<Section, { title: string; hint: string }> = {
  chat: { title: 'Conversations', hint: 'Channels and direct messages' },
  drive: { title: 'Drive', hint: 'Files and documents' },
  agents: { title: 'Agents', hint: 'Your AI specialists' },
  crm: { title: 'CRM', hint: 'Contacts, companies and deals' },
  workspace: { title: 'Workspace', hint: 'Plan and track the work' },
};

export function Sidebar({ primaryNavigation, secondaryNavigation = [] }: SidebarProps) {
  const { pathname, search } = useLocation();
  const { isExpanded, toggleSidebar } = useLayout();
  const { currentWorkspace } = useWorkspace();
  const features = useFeatureAccess();
  const tablet = useIsTablet();
  const collapsed = tablet || !isExpanded;

  const section: Section = /^\/(channels|dm|messages|threads|saved-pinned)/.test(pathname)
    ? 'chat'
    : /^\/(drive|files)/.test(pathname)
      ? 'drive'
      : /^\/(agents|ai)/.test(pathname)
        ? 'agents'
        : pathname.startsWith('/crm')
          ? 'crm'
          : 'workspace';
  // Projects, calendar and channels live in the submenu rather than the rail.
  const rail = primaryNavigation.filter((n) => !['/projects', '/calendar', '/channels'].includes(n.to));

  const isLinkActive = (to: string, isActive: boolean) => {
    if (!to.includes('?')) return isActive;
    const [path, query] = to.split('?');
    return pathname === path && new URLSearchParams(search).get('view') === new URLSearchParams(query).get('view');
  };

  const link = (to: string, label: string, glyph: string) => features.pathHidden(to) ? null : (
    <NavLink
      key={to}
      to={to}
      end={to === '/' || to === '/agents'}
      className={({ isActive }) => `${styles.item} ${isLinkActive(to, isActive) ? styles.itemActive : ''}`}
    >
      <Glyph name={glyph} />
      <span className={styles.itemLabel}>{label}</span>
    </NavLink>
  );

  const group = (label: string, children: ReactNode) => (
    <div className={styles.group}>
      <div className={styles.groupLabel}>{label}</div>
      {children}
    </div>
  );

  const submenu: Record<Section, ReactNode> = {
    chat: (
      <>
        {group(
          'Inbox',
          <>
            {link('/threads', 'Followed threads', 'threads')}
            {link('/notifications', 'Mentions & activity', 'mentions')}
            {link('/saved-pinned', 'Saved & pinned', 'saved')}
          </>,
        )}
        <div className={styles.group}>
          <ChannelSidebar />
        </div>
        <div className={styles.group}>
          <DmSidebar isCollapsed={false} />
        </div>
      </>
    ),
    drive: group(
      'Browse',
      <>
        {link('/drive?view=workspace', 'Workspace files', 'folder')}
        {link('/drive?view=my', 'My files', 'user')}
        {link('/drive?view=shared', 'Shared with me', 'share')}
        {link('/drive?view=recent', 'Recent', 'clock')}
        {link('/drive?view=starred', 'Starred', 'star')}
        {link('/drive?view=trash', 'Trash', 'trash')}
      </>,
    ),
    agents: (
      <>
        {group(
          'Agents',
          <>
            {link('/agents', 'Agent directory', 'agents')}
            {link('/agents/team', 'Team chat', 'team')}
          </>,
        )}
        <p className={styles.hint}>Open an agent to start a private conversation, choose knowledge sources and review its proposals.</p>
      </>
    ),
    crm: group(
      'Records',
      <>
        {link('/crm/contacts', 'Contacts', 'user')}
        {link('/crm/companies', 'Companies', 'building')}
        {link('/crm/deals', 'Deals', 'deal')}
      </>,
    ),
    workspace: group(
      'Plan',
      <>
        {link('/', 'Overview', 'overview')}
        {link('/tasks', 'Tasks', 'tasks')}
        {link('/projects', 'Projects', 'projects')}
        {link('/calendar', 'Calendar', 'calendar')}
        {link('/channels', 'Browse channels', 'channels')}
      </>,
    ),
  };

  return (
    <aside className={styles.shell} aria-label="Workspace navigation">
      <nav className={styles.rail} aria-label="Sections">
        <div className={styles.brand} title="Darkspace" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 3c2.5 3 2.5 6 0 9-2.5-3-2.5-6 0-9zM12 21c-2.5-3-2.5-6 0-9 2.5 3 2.5 6 0 9zM3 12c3-2.5 6-2.5 9 0-3 2.5-6 2.5-9 0zM21 12c-3 2.5-6 2.5-9 0 3-2.5 6-2.5 9 0z" />
          </svg>
        </div>
        <WorkspaceSwitcher collapsed />
        <div className={styles.railLinks}>
          {rail.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              aria-label={n.label}
              title={n.label}
              className={({ isActive }) => `${styles.railLink} ${isActive ? styles.railLinkActive : ''}`}
            >
              <span className={styles.railIcon}>{n.icon}</span>
              <span className={styles.railLabel}>{n.label}</span>
            </NavLink>
          ))}
        </div>
        <div className={styles.railBottom}>
          <NavLink to="/notifications" className={({ isActive }) => `${styles.railLink} ${isActive ? styles.railLinkActive : ''}`} title="Activity" aria-label="Activity">
            <span className={styles.railIcon}><BellIcon /></span>
            <span className={styles.railLabel}>Activity</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `${styles.railLink} ${isActive ? styles.railLinkActive : ''}`} title="Settings" aria-label="Settings">
            <span className={styles.railIcon}><SettingsIcon /></span>
            <span className={styles.railLabel}>Settings</span>
          </NavLink>
          <UserMenu collapsed />
        </div>
      </nav>

      {!collapsed && (
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitles}>
              <span className={styles.panelTitle}>{SECTION_TITLES[section].title}</span>
              <span className={styles.panelHint}>{currentWorkspace?.name ?? SECTION_TITLES[section].hint}</span>
            </div>
            <button type="button" aria-label="Collapse sidebar" title="Collapse sidebar" className={styles.collapse} onClick={toggleSidebar}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16M15 10l-2 2 2 2" />
              </svg>
            </button>
          </div>
          <div className={styles.panelBody}>
            {submenu[section]}
            <details className={styles.more}>
              <summary className={styles.moreSummary}>
                <Glyph name="more" />
                <span className={styles.itemLabel}>More tools</span>
                <svg className={styles.moreChevron} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </summary>
              <div className={styles.moreList}>
                {secondaryNavigation.map((n) => (
                  <NavLink key={n.to} to={n.to} className={({ isActive }) => `${styles.item} ${isActive ? styles.itemActive : ''}`}>
                    <span className={styles.secondaryIcon}>{n.icon}</span>
                    <span className={styles.itemLabel}>{n.label}</span>
                  </NavLink>
                ))}
              </div>
            </details>
          </div>
        </div>
      )}
      {collapsed && !tablet && (
        <button type="button" className={styles.expand} onClick={toggleSidebar} aria-label="Expand sidebar" title="Expand sidebar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
      )}
    </aside>
  );
}
