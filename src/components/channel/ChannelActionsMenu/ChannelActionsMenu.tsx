import { useState, useRef, useEffect } from 'react';
import { useChannel } from '@/hooks/useChannel';
import { useBulkMessageActions } from '@/hooks/useBulkMessageActions';
import { ShareMessageDialog } from '@/components/message/ShareMessageDialog';
import { BulkDeleteConfirmDialog } from '@/components/message/BulkDeleteConfirmDialog';
import type { Channel } from '@/types';
import styles from './ChannelActionsMenu.module.css';

interface ChannelActionsMenuProps {
  channel: Channel;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onLeave: () => void;
  onInvite?: () => void;
  onCreateChannel?: () => void;
  onTogglePinned?: () => void;
  pinnedOpen?: boolean;
}

export function ChannelActionsMenu({ channel, onEdit, onArchive, onDelete, onLeave, onInvite, onCreateChannel, onTogglePinned, pinnedOpen = false }: ChannelActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { isMember } = useChannel();
  const bulk = useBulkMessageActions();

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleAction(action: () => void) {
    setIsOpen(false);
    action();
  }

  const isArchived = !!channel.archived_at;
  const isUserMember = isMember(channel.id);

  return (
    <div className={styles.container} ref={menuRef}>
      <button
        className={styles.trigger}
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        type="button"
        aria-label="Channel actions"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </button>

      {isOpen && (
        <div className={styles.menu} role="menu">
          {bulk.selectedCount > 0 && (
            <>
              <div className={styles.menuSectionLabel}>
                {bulk.selectedCount} selected
              </div>
              <button
                className={styles.menuItem}
                onClick={() => handleAction(bulk.openBulkForward)}
                type="button"
                role="menuitem"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
                Forward
              </button>
              <button
                className={`${styles.menuItem} ${styles.menuItemDanger}`}
                onClick={() => handleAction(bulk.openBulkDelete)}
                type="button"
                role="menuitem"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
                Delete
              </button>
              <button
                className={styles.menuItem}
                onClick={() => handleAction(bulk.clearSelection)}
                type="button"
                role="menuitem"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                Cancel
              </button>
              <div className={styles.divider} />
            </>
          )}

          {onCreateChannel && (
            <button
              className={styles.menuItem}
              onClick={() => handleAction(onCreateChannel)}
              type="button"
              role="menuitem"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Create channel
            </button>
          )}

          <button
            className={styles.menuItem}
            onClick={() => handleAction(onEdit)}
            type="button"
            role="menuitem"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit channel
          </button>

          {onTogglePinned && (
            <button
              className={`${styles.menuItem} ${pinnedOpen ? styles.menuItemActive : ''}`}
              onClick={() => handleAction(onTogglePinned)}
              type="button"
              role="menuitem"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="17" x2="12" y2="22" />
                <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V17z" />
              </svg>
              {pinnedOpen ? 'Hide pinned' : 'Pinned messages'}
            </button>
          )}

          {channel.is_private && onInvite && (
            <button
              className={styles.menuItem}
              onClick={() => handleAction(onInvite)}
              type="button"
              role="menuitem"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                <circle cx="8.5" cy="7" r="4" />
                <line x1="20" y1="8" x2="20" y2="14" />
                <line x1="23" y1="11" x2="17" y2="11" />
              </svg>
              Manage members
            </button>
          )}

          <button
            className={styles.menuItem}
            onClick={() => handleAction(onArchive)}
            type="button"
            role="menuitem"
          >
            {isArchived ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
                </svg>
                Restore channel
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="21 8 21 21 3 21 3 8" />
                  <rect x="1" y="3" width="22" height="5" />
                  <line x1="10" y1="12" x2="14" y2="12" />
                </svg>
                Archive channel
              </>
            )}
          </button>

          {isUserMember && (
            <>
              <div className={styles.divider} />
              <button
                className={`${styles.menuItem} ${styles.menuItemDanger}`}
                onClick={() => handleAction(onLeave)}
                type="button"
                role="menuitem"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Leave channel
              </button>
            </>
          )}

          <div className={styles.divider} />

          <button
            className={`${styles.menuItem} ${styles.menuItemDanger}`}
            onClick={() => handleAction(onDelete)}
            type="button"
            role="menuitem"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
            Delete channel
          </button>
        </div>
      )}
      <ShareMessageDialog
        open={bulk.forwardOpen}
        onClose={bulk.closeBulkForward}
        message={bulk.selectedMessages[0]}
        messages={bulk.selectedMessages}
        excludeChannelId={channel.id}
      />
      <BulkDeleteConfirmDialog
        open={bulk.deleteOpen}
        onClose={bulk.closeBulkDelete}
        onConfirm={bulk.deleteSelected}
        count={bulk.deletableCount}
        totalCount={bulk.selectedCount}
        isDeleting={bulk.isDeleting}
      />
    </div>
  );
}
