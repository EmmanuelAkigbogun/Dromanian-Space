import { useState, useEffect, useRef, memo, useCallback, useMemo } from 'react';
import { useProfiles } from '@/hooks/useProfiles';
import { Avatar } from '@/components/ui/Avatar';
import { getDisplayName } from '@/lib/message';
import styles from './MentionDropdown.module.css';

interface MentionDropdownProps {
  query: string;
  onSelect: (username: string) => void;
  onClose: () => void;
  memberIds: string[];
  /** Offer @all (General channel only): notifies every member. */
  allowAll?: boolean;
}

type Item = { kind: 'all' } | { kind: 'member'; id: string; name: string; avatar: string | undefined };

export const MentionDropdown = memo(function MentionDropdown({
  query,
  onSelect,
  onClose,
  memberIds,
  allowAll = false,
}: MentionDropdownProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { profiles } = useProfiles(memberIds);

  const items = useMemo<Item[]>(() => {
    const q = query.toLowerCase();
    const members: Item[] = memberIds
      .map((id) => ({ id, profile: profiles.get(id) ?? null }))
      .filter(({ profile }) => {
        if (!profile) return false;
        const name = getDisplayName(profile, '');
        return name.toLowerCase().includes(q);
      })
      .slice(0, 8)
      .map(({ id, profile }) => ({ kind: 'member', id, name: getDisplayName(profile, id), avatar: profile?.avatar_url || undefined }));
    return allowAll && ('all'.startsWith(q) || 'everyone'.startsWith(q)) ? [{ kind: 'all' }, ...members] : members;
  }, [query, memberIds, profiles, allowAll]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const choose = useCallback((item: Item) => onSelect(item.kind === 'all' ? 'all' : item.name), [onSelect]);

  useEffect(() => {
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && items.length > 0) {
        e.preventDefault();
        const selected = items[selectedIndex];
        if (selected) choose(selected);
      } else if (e.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [items, selectedIndex, choose, onClose]);

  if (items.length === 0) return null;

  return (
    <div ref={listRef} className={styles.dropdown}>
      {items.map((item, index) => (
        <button
          key={item.kind === 'all' ? '@all' : item.id}
          type="button"
          className={`${styles.item} ${index === selectedIndex ? styles.itemActive : ''}`}
          onClick={() => choose(item)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          {item.kind === 'all' ? (
            <>
              <span className={styles.allIcon} aria-hidden="true">@</span>
              <span className={styles.name}>all</span>
              <span className={styles.hint}>Notify everyone in this channel</span>
            </>
          ) : (
            <>
              <Avatar src={item.avatar} name={item.name} size="xs" />
              <span className={styles.name}>{item.name}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
});
