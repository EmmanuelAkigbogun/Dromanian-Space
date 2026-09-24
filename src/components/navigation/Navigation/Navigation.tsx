import { NavItem } from '../NavItem';
import styles from './Navigation.module.css';

interface NavigationItem {
  to: string;
  icon: React.ReactNode;
  label: string;
}

interface NavigationProps {
  items: NavigationItem[];
  secondaryItems?: NavigationItem[];
  collapsed?: boolean;
}

export function Navigation({ items, secondaryItems, collapsed = false }: NavigationProps) {
  return (
    <nav className={styles.navigation} aria-label="Main navigation">
      <div className={styles.navigationSection}>
        {items.map((item) => (
          <NavItem key={item.to} to={item.to} icon={item.icon} label={item.label} collapsed={collapsed} />
        ))}
      </div>

      {secondaryItems && secondaryItems.length > 0 && (
        <>
          <div className={styles.navigationDivider} role="separator" />
          <div className={styles.navigationSection}>
            {secondaryItems.map((item) => (
              <NavItem key={item.to} to={item.to} icon={item.icon} label={item.label} collapsed={collapsed} />
            ))}
          </div>
        </>
      )}
    </nav>
  );
}
