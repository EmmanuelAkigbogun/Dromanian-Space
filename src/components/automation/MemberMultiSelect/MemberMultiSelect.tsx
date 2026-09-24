import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import styles from './MemberMultiSelect.module.css';

interface Member {
  id: string;
  email: string;
  display_name: string | null;
  username: string | null;
}

interface MemberMultiSelectProps {
  label?: string;
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
}

export function MemberMultiSelect({
  label,
  value,
  onChange,
  placeholder = 'Select one or more members...',
}: MemberMultiSelectProps) {
  const { currentWorkspace } = useWorkspace();
  const [members, setMembers] = useState<Member[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!currentWorkspace) return;
    (async () => {
      const { data } = await supabase
        .from('workspace_members' as never)
        .select('user_id')
        .eq('workspace_id', currentWorkspace.id);
      const userIds = ((data ?? []) as unknown as Array<{ user_id: string }>).map((m) => m.user_id);
      if (userIds.length === 0) return;
      const { data: profiles } = await supabase
        .from('profiles' as never)
        .select('id, email, display_name, username')
        .in('id', userIds);
      setMembers((profiles ?? []) as unknown as Member[]);
    })();
  }, [currentWorkspace]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const nameOf = (m: Member) => m.display_name || m.username || m.email;

  const toggleMember = (id: string) => {
    if (value.includes(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id]);
    }
  };

  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? members.filter(
        (m) =>
          (m.email || '').toLowerCase().includes(normalized) ||
          (m.display_name || '').toLowerCase().includes(normalized) ||
          (m.username || '').toLowerCase().includes(normalized),
      )
    : members;

  const selected = members.filter((m) => value.includes(m.id));

  return (
    <div className={styles.container} ref={rootRef}>
      {label && <span className={styles.label}>{label}</span>}
      <div className={styles.control} onClick={() => setOpen((o) => !o)}>
        {selected.length > 0 ? (
          <>
            <div className={styles.chips}>
              {selected.map((m) => (
                <span key={m.id} className={styles.chip}>
                  {nameOf(m)}
                  <button
                    type="button"
                    className={styles.chipRemove}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleMember(m.id);
                    }}
                    aria-label={`Remove ${nameOf(m)}`}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
            <button
              type="button"
              className={styles.clearButton}
              onClick={(e) => {
                e.stopPropagation();
                onChange([]);
              }}
              aria-label="Clear all members"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </>
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
      </div>

      {open && (
        <div className={styles.dropdown} onClick={(e) => e.stopPropagation()}>
          <input
            type="text"
            className={styles.search}
            value={query}
            placeholder="Search by email or name..."
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {filtered.length === 0 && <span className={styles.empty}>No matching members</span>}
          {filtered.map((member) => {
            const isSelected = value.includes(member.id);
            return (
              <button
                type="button"
                key={member.id}
                className={`${styles.option} ${isSelected ? styles.optionSelected : ''}`}
                onClick={() => toggleMember(member.id)}
              >
                <span className={styles.optionEmail}>{member.email}</span>
                <span className={styles.optionName}>{nameOf(member)}</span>
                <span className={styles.checkbox}>{isSelected ? '✓' : ''}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
