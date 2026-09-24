import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { Radio } from '@/components/ui/Radio/Radio';
import { Avatar } from '@/components/ui/Avatar/Avatar';
import { getWorkspaceMembersWithProfiles } from '@/lib/channel/channel';
import { useWorkspace } from '@/hooks/useWorkspace';
import type { WorkspaceMemberWithProfile } from '@/lib/channel/channel';
import type { AutomationVisibility, UUID } from '@/types';
import styles from './AutomationVisibilityDialog.module.css';

interface AutomationVisibilityDialogProps {
  open: boolean;
  visibility: AutomationVisibility;
  visibleMembers: UUID[];
  onSave: (visibility: AutomationVisibility, visibleMembers: UUID[]) => Promise<boolean>;
  onClose: () => void;
}

const MODE_OPTIONS: Array<{ value: AutomationVisibility; label: string; description: string }> = [
  { value: 'own', label: 'My automations', description: 'Only see the rules you created.' },
  { value: 'all', label: "Everyone's automations", description: 'See every automation rule in this workspace.' },
  { value: 'selected', label: "Selected members' automations", description: 'Only see rules created by the members you pick.' },
];

function memberName(member: WorkspaceMemberWithProfile): string {
  const p = member.profile;
  if (p?.display_name) return p.display_name;
  if (p?.username) return p.username;
  return p?.email || member.user_id;
}

export function AutomationVisibilityDialog({
  open,
  visibility,
  visibleMembers,
  onSave,
  onClose,
}: AutomationVisibilityDialogProps) {
  const { currentWorkspace } = useWorkspace();
  const [members, setMembers] = useState<WorkspaceMemberWithProfile[]>([]);
  const [mode, setMode] = useState<AutomationVisibility>(visibility);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(visibleMembers));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode(visibility);
    setSelectedIds(new Set(visibleMembers));
    setError(null);
    setSaving(false);
  }, [open, visibility, visibleMembers]);

  useEffect(() => {
    if (!open || !currentWorkspace?.id) return;
    let cancelled = false;
    getWorkspaceMembersWithProfiles(currentWorkspace.id).then((data) => {
      if (!cancelled) setMembers(data);
    });
    return () => {
      cancelled = true;
    };
  }, [open, currentWorkspace?.id]);

  const toggleMember = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    if (mode === 'selected' && selectedIds.size === 0) {
      setError('Pick at least one member.');
      return;
    }
    setSaving(true);
    const ok = await onSave(mode, [...selectedIds]);
    setSaving(false);
    if (ok) {
      onClose();
    } else {
      setError('Failed to save visibility settings.');
    }
  };

  const footer = (
    <div className={styles.footer}>
      <button type="button" className={styles.cancelButton} onClick={onClose} disabled={saving}>
        Cancel
      </button>
      <button type="button" className={styles.saveButton} onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );

  return (
    <Dialog open={open} onClose={onClose} title="Automation visibility" footer={footer}>
      <div className={styles.options}>
        {MODE_OPTIONS.map((option) => (
          <Radio
            key={option.value}
            id={`automation-visibility-${option.value}`}
            name="automation-visibility"
            value={option.value}
            checked={mode === option.value}
            onChange={() => setMode(option.value)}
            label={option.label}
            description={option.description}
          />
        ))}
      </div>

      {mode === 'selected' && (
        <div className={styles.memberList}>
          {members.map((member) => {
            const name = memberName(member);
            return (
              <label key={member.user_id} className={styles.memberRow}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={selectedIds.has(member.user_id)}
                  onChange={() => toggleMember(member.user_id)}
                />
                <Avatar
                  src={member.profile?.avatar_url ?? undefined}
                  name={name}
                  size="xs"
                />
                <span className={styles.memberName}>{name}</span>
              </label>
            );
          })}
          {members.length === 0 && (
            <p className={styles.empty}>Loading members...</p>
          )}
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}

      <p className={styles.hint}>
        This only changes what you see. Other members choose their own view, and you can always
        edit or delete the automations you created.
      </p>
    </Dialog>
  );
}
