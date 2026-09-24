import { NavLink, type NavLinkProps } from 'react-router-dom';
import styles from './NavItem.module.css';

interface NavItemProps {
  to: NavLinkProps['to'];
  icon: React.ReactNode;
  label: string;
  collapsed?: boolean;
}

export function NavItem({ to, icon, label, collapsed = false }: NavItemProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `${styles.navItem} ${isActive ? styles.navItemActive : ''} ${collapsed ? styles.navItemCollapsed : ''}`
      }
      title={collapsed ? label : undefined}
      aria-label={label}
    >
      <span className={styles.navItemIcon}>{icon}</span>
      {!collapsed && <span className={styles.navItemLabel}>{label}</span>}
    </NavLink>
  );
}
