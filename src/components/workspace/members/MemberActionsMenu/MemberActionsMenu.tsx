import { DropdownMenu, DropdownTrigger as Trigger, DropdownContent as Content, DropdownItem as Item, DropdownSeparator as Separator } from '@/components/ui/DropdownMenu';
import { IconButton } from '@/components/ui/IconButton';
import styles from './MemberActionsMenu.module.css';

interface MemberActionsMenuProps {
  currentRole: 'admin' | 'member';
  onRoleChange: (role: 'admin' | 'member') => void;
  onRemove: () => void;
}

export function MemberActionsMenu({ currentRole, onRoleChange, onRemove }: MemberActionsMenuProps) {
  return (
    <DropdownMenu>
      <Trigger>
        <IconButton label="Member actions" size="sm" variant="default">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="5" r="1" />
            <circle cx="12" cy="12" r="1" />
            <circle cx="12" cy="19" r="1" />
          </svg>
        </IconButton>
      </Trigger>
      <Content side="bottom" align="end">
        <Item
          onClick={() => onRoleChange(currentRole === 'admin' ? 'member' : 'admin')}
        >
          {currentRole === 'admin' ? 'Demote to member' : 'Promote to admin'}
        </Item>
        <Separator />
        <Item onClick={onRemove} disabled={false}>
          <span className={styles.dangerText}>Remove from workspace</span>
        </Item>
      </Content>
    </DropdownMenu>
  );
}
