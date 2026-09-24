import { useState, useRef, useEffect } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { canInviteMembers } from '@/lib/workspace';
import { WorkspaceAvatar } from '@/components/workspace/WorkspaceAvatar';
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog';
import { InviteMemberDialog } from '@/components/workspace/members/InviteMemberDialog';
import styles from './WorkspaceSwitcher.module.css';

interface WorkspaceSwitcherProps {
  collapsed?: boolean;
}

export function WorkspaceSwitcher({ collapsed = false }: WorkspaceSwitcherProps) {
  const { workspaces, currentWorkspace, currentRole, switchWorkspace } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);

  const canInvite = currentWorkspace ? canInviteMembers(currentRole) : false;

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleToggle() {
    if (!isOpen && collapsed && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.right + 4 });
    }
    setIsOpen(!isOpen);
  }

  function handleSwitch(slug: string) {
    switchWorkspace(slug);
    setIsOpen(false);
  }

  function handleDialogClose() {
    setIsDialogOpen(false);
    setIsInviteOpen(false);
    setIsOpen(false);
  }

  if (collapsed) {
    return (
      <>
        <div className={styles.switcherCollapsed} ref={dropdownRef}>
          <button
            ref={triggerRef}
            className={styles.triggerCollapsed}
            onClick={handleToggle}
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-label={currentWorkspace ? `Workspace: ${currentWorkspace.name}` : 'Create workspace'}
            type="button"
            title={currentWorkspace?.name ?? 'Create workspace'}
          >
            <WorkspaceAvatar name={currentWorkspace?.name ?? '+'} avatarUrl={currentWorkspace?.avatar_url ?? null} size="md" />
          </button>

          {isOpen && dropdownPos && (
            <div className={styles.dropdown} role="listbox" style={{ top: dropdownPos.top, left: dropdownPos.left, position: 'fixed' }}>
              <div className={styles.sectionLabel}>Workspaces</div>
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className={`${styles.option} ${workspace.id === currentWorkspace?.id ? styles.optionActive : ''}`}
                  onClick={() => handleSwitch(workspace.slug)}
                  role="option"
                  aria-selected={workspace.id === currentWorkspace?.id}
                  type="button"
                >
                  <WorkspaceAvatar name={workspace.name} avatarUrl={workspace.avatar_url} size="sm" />
                  <div className={styles.optionInfo}>
                    <span className={styles.optionName}>{workspace.name}</span>
                    {workspace.description && (
                      <span className={styles.optionDescription}>{workspace.description}</span>
                    )}
                  </div>
                </button>
              ))}

              <button
                className={styles.createButton}
                onClick={() => setIsDialogOpen(true)}
                type="button"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Create new workspace
              </button>
              {canInvite && (
                <button
                  className={styles.inviteButton}
                  onClick={() => setIsInviteOpen(true)}
                  type="button"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="8.5" cy="7" r="4" />
                    <line x1="20" y1="8" x2="20" y2="14" />
                    <line x1="23" y1="11" x2="17" y2="11" />
                  </svg>
                  Invite member
                </button>
              )}
            </div>
          )}
        </div>

        <CreateWorkspaceDialog open={isDialogOpen} onClose={handleDialogClose} />
        {currentWorkspace && <InviteMemberDialog open={isInviteOpen} onClose={handleDialogClose} />}
      </>
    );
  }

  return (
    <>
      <div className={styles.switcher} ref={dropdownRef}>
        <button
          className={styles.trigger}
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          type="button"
        >
          <WorkspaceAvatar name={currentWorkspace?.name ?? '?'} avatarUrl={currentWorkspace?.avatar_url ?? null} size="md" />
          <span className={styles.name}>{currentWorkspace?.name ?? 'Select Workspace'}</span>
          <svg className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {isOpen && (
          <div className={styles.dropdown} role="listbox">
            <div className={styles.sectionLabel}>Workspaces</div>
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                className={`${styles.option} ${workspace.id === currentWorkspace?.id ? styles.optionActive : ''}`}
                onClick={() => handleSwitch(workspace.slug)}
                role="option"
                aria-selected={workspace.id === currentWorkspace?.id}
                type="button"
              >
                <WorkspaceAvatar name={workspace.name} avatarUrl={workspace.avatar_url} size="sm" />
                <div className={styles.optionInfo}>
                  <span className={styles.optionName}>{workspace.name}</span>
                  {workspace.description && (
                    <span className={styles.optionDescription}>{workspace.description}</span>
                  )}
                </div>
              </button>
            ))}

            <button
              className={styles.createButton}
              onClick={() => setIsDialogOpen(true)}
              type="button"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Create new workspace
            </button>
            {canInvite && (
              <button
                className={styles.inviteButton}
                onClick={() => setIsInviteOpen(true)}
                type="button"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="8.5" cy="7" r="4" />
                  <line x1="20" y1="8" x2="20" y2="14" />
                  <line x1="23" y1="11" x2="17" y2="11" />
                </svg>
                Invite member
              </button>
            )}
          </div>
        )}
      </div>

      <CreateWorkspaceDialog open={isDialogOpen} onClose={handleDialogClose} />
      {currentWorkspace && <InviteMemberDialog open={isInviteOpen} onClose={handleDialogClose} />}
    </>
  );
}
