import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar } from '@/components/ui/Avatar';
import { Dialog } from '@/components/ui/Dialog';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { Floating } from '@/lib/overlay/Floating';
import styles from './UserMenu.module.css';

interface UserMenuProps {
  collapsed?: boolean;
}

export function UserMenu({ collapsed }: UserMenuProps) {
  const { signOut } = useAuth();
  const { displayName, avatarUrl } = useProfile();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  function handleProfile() {
    setIsOpen(false);
    navigate('/profile');
  }

  function handleAccounts() {
    setIsOpen(false);
    navigate('/settings?tab=accounts');
  }

  async function handleSignOut() {
    setIsOpen(false);
    await signOut();
  }

  if (collapsed) {
    return (
      <>
        <button
          type="button"
          className={styles.triggerCollapsed}
          onClick={() => setIsOpen(true)}
          aria-label="User menu"
        >
          <Avatar src={avatarUrl ?? undefined} name={displayName} size="sm" />
        </button>

        <Dialog open={isOpen} onClose={() => setIsOpen(false)} size="sm">
          <div className={styles.modalContent}>
            <div className={styles.modalHeader}>
              <Avatar src={avatarUrl ?? undefined} name={displayName} size="lg" />
              <span className={styles.headerName}>{displayName}</span>
            </div>
            <div className={styles.separator} />
            <button type="button" className={styles.item} role="menuitem" onClick={handleProfile}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              Profile
            </button>
            <button type="button" className={styles.item} role="menuitem" onClick={handleAccounts}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>
              Connected accounts
            </button>
            <button type="button" className={`${styles.item} ${styles.itemDanger}`} role="menuitem" onClick={handleSignOut}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Sign out
            </button>
          </div>
        </Dialog>
      </>
    );
  }

  return (
    <div className={styles.wrapper} ref={menuRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <Avatar src={avatarUrl ?? undefined} name={displayName} size="sm" />
        <span className={styles.name}>{displayName}</span>
      </button>

      <Floating open={isOpen} anchor={menuRef} placement="top-start" offset={4} matchWidth onDismiss={() => setIsOpen(false)} className={styles.dropdown} role="menu">
          <div className={styles.header}>
            <Avatar src={avatarUrl ?? undefined} name={displayName} size="lg" />
            <div className={styles.headerInfo}>
              <span className={styles.headerName}>{displayName}</span>
            </div>
          </div>
          <div className={styles.separator} />
          <button type="button" className={styles.item} role="menuitem" onClick={handleProfile}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Profile
          </button>
          <button type="button" className={styles.item} role="menuitem" onClick={handleAccounts}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>
            Connected accounts
          </button>
          <button type="button" className={`${styles.item} ${styles.itemDanger}`} role="menuitem" onClick={handleSignOut}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign out
          </button>
      </Floating>
    </div>
  );
}
