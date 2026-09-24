import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import type { WorkspaceRole } from '@/types';

interface RoleChangeDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (newRole: WorkspaceRole) => void;
  memberName: string;
  memberEmail: string;
  memberAvatar?: string | null;
  currentRole: WorkspaceRole;
  isLoading?: boolean;
}

const ROLE_DESCRIPTIONS: Record<WorkspaceRole, { label: string; description: string }> = {
  owner: {
    label: 'Owner',
    description: 'Full control. Can manage everything including ownership transfer.',
  },
  admin: {
    label: 'Admin',
    description: 'Can manage members, invitations, and workspace settings.',
  },
  member: {
    label: 'Member',
    description: 'Can view channels and send messages.',
  },
};

export function RoleChangeDialog({
  open,
  onClose,
  onConfirm,
  memberName,
  memberEmail,
  memberAvatar,
  currentRole,
  isLoading = false,
}: RoleChangeDialogProps) {
  const availableRoles: WorkspaceRole[] = currentRole === 'admin'
    ? ['member']
    : ['admin'];

  const [selectedRole, setSelectedRole] = useState<WorkspaceRole>(availableRoles[0]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change role"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(selectedRole)} loading={isLoading}>
            Change role
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <Avatar
          src={memberAvatar ?? undefined}
          name={memberName}
          size="md"
        />
        <div>
          <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text)' }}>
            {memberName}
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
            {memberEmail}
          </div>
        </div>
      </div>

      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)' }}>
        Current role: <strong style={{ color: 'var(--color-text)' }}>{ROLE_DESCRIPTIONS[currentRole].label}</strong>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {availableRoles.map((role) => (
          <label
            key={role}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--space-3)',
              padding: 'var(--space-3)',
              borderRadius: 'var(--radius-md)',
              border: `1px solid ${selectedRole === role ? 'var(--color-primary)' : 'var(--color-border)'}`,
              backgroundColor: selectedRole === role ? 'var(--color-primary-subtle)' : 'transparent',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)',
            }}
          >
            <input
              type="radio"
              name="role-select"
              value={role}
              checked={selectedRole === role}
              onChange={() => setSelectedRole(role)}
              style={{ marginTop: '2px' }}
            />
            <div>
              <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text)' }}>
                {ROLE_DESCRIPTIONS[role].label}
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
                {ROLE_DESCRIPTIONS[role].description}
              </div>
            </div>
          </label>
        ))}
      </div>
    </Dialog>
  );
}
