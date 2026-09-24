import { useState, useRef, useEffect } from 'react';
import styles from './MembersList.module.css';

interface MemberActionsMenuProps {
  currentRole: 'admin' | 'member';
  onRoleChange: (role: 'admin' | 'member') => void;
  onRemove: () => void;
}

export function MemberActionsMenu({ currentRole, onRoleChange, onRemove }: MemberActionsMenuProps) {
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

  return (
    <div className={styles.actionsMenu} ref={menuRef}>
      <button
        type="button"
        className={styles.actionsTrigger}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Member actions"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </button>

      {isOpen && (
        <div className={styles.actionsDropdown}>
          {currentRole === 'member' && (
            <button
              type="button"
              className={styles.actionsItem}
              onClick={() => {
                onRoleChange('admin');
                setIsOpen(false);
              }}
            >
              Promote to admin
            </button>
          )}
          {currentRole === 'admin' && (
            <button
              type="button"
              className={styles.actionsItem}
              onClick={() => {
                onRoleChange('member');
                setIsOpen(false);
              }}
            >
              Demote to member
            </button>
          )}
          <button
            type="button"
            className={`${styles.actionsItem} ${styles.actionsItemDanger}`}
            onClick={() => {
              onRemove();
              setIsOpen(false);
            }}
          >
            Remove member
          </button>
        </div>
      )}
    </div>
  );
}
