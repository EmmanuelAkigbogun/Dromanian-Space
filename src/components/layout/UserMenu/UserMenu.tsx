import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar } from '@/components/ui/Avatar';
import { Dialog } from '@/components/ui/Dialog';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
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

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  function handleProfile() {
    setIsOpen(false);
    navigate('/profile');
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

      {isOpen && (
        <div className={styles.dropdown} role="menu">
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
          <button type="button" className={`${styles.item} ${styles.itemDanger}`} role="menuitem" onClick={handleSignOut}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
