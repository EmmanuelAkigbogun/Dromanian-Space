import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import styles from './MemberSelect.module.css';

interface Member {
  id: string;
  email: string;
  display_name: string | null;
  username: string | null;
}

interface MemberSelectProps {
  label?: string;
  value: string;
  onChange: (userId: string) => void;
  placeholder?: string;
}

export function MemberSelect({ label, value, onChange, placeholder = 'Search by email or name...' }: MemberSelectProps) {
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

  const selected = members.find((m) => m.id === value) ?? null;

  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? members.filter(
        (m) =>
          (m.email || '').toLowerCase().includes(normalized) ||
          (m.display_name || '').toLowerCase().includes(normalized) ||
          (m.username || '').toLowerCase().includes(normalized),
      )
    : members;

  const selectMember = (member: Member) => {
    onChange(member.id);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className={styles.container} ref={rootRef}>
      {label && <span className={styles.label}>{label}</span>}
      <div className={styles.control} onClick={() => setOpen(true)}>
        {selected ? (
          <>
            <span className={styles.chip}>{selected.email}</span>
            <button
              type="button"
              className={styles.clearButton}
              onClick={(e) => {
                e.stopPropagation();
                onChange('');
              }}
              aria-label="Clear member"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </>
        ) : (
          <input
            type="text"
            className={styles.input}
            value={query}
            placeholder={placeholder}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setOpen(true)}
          />
        )}
      </div>

      {open && !selected && (
        <div className={styles.dropdown}>
          {filtered.length === 0 && <span className={styles.empty}>No matching members</span>}
          {filtered.map((member) => (
            <button
              type="button"
              key={member.id}
              className={styles.option}
              onClick={() => selectMember(member)}
            >
              <span className={styles.optionEmail}>{member.email}</span>
              <span className={styles.optionName}>
                {member.display_name || member.username || ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
