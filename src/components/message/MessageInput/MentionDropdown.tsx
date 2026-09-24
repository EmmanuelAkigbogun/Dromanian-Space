import { useState, useEffect, useRef, memo, useCallback } from 'react';
import { useProfiles } from '@/hooks/useProfiles';
import { Avatar } from '@/components/ui/Avatar';
import { getDisplayName } from '@/lib/message';
import styles from './MentionDropdown.module.css';

interface MentionDropdownProps {
  query: string;
  onSelect: (username: string) => void;
  onClose: () => void;
  memberIds: string[];
}

export const MentionDropdown = memo(function MentionDropdown({
  query,
  onSelect,
  onClose,
  memberIds,
}: MentionDropdownProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { profiles } = useProfiles(memberIds);

  const filtered = memberIds
    .map((id) => ({ id, profile: profiles.get(id) ?? null }))
    .filter(({ profile }) => {
      if (!profile) return false;
      const name = getDisplayName(profile, '');
      return name.toLowerCase().includes(query.toLowerCase());
    })
    .slice(0, 8);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && filtered.length > 0) {
        e.preventDefault();
        const selected = filtered[selectedIndex];
        if (selected) {
          const name = getDisplayName(selected.profile, selected.id);
          onSelect(name);
        }
      } else if (e.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [filtered, selectedIndex, onSelect, onClose]);

  const handleClick = useCallback((username: string) => {
    onSelect(username);
  }, [onSelect]);

  if (filtered.length === 0) return null;

  return (
    <div ref={listRef} className={styles.dropdown}>
      {filtered.map(({ id, profile }, index) => {
        const name = getDisplayName(profile, id);
        return (
          <button
            key={id}
            type="button"
            className={`${styles.item} ${index === selectedIndex ? styles.itemActive : ''}`}
            onClick={() => handleClick(name)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <Avatar
              src={profile?.avatar_url || undefined}
              name={name}
              size="xs"
            />
            <span className={styles.name}>{name}</span>
          </button>
        );
      })}
    </div>
  );
});
