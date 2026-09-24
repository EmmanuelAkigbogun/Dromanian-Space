import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Portal } from '@/lib/overlay/Portal';
import { useFocusTrap } from '@/lib/overlay/useFocusTrap';
import { useCommandPaletteContext } from '@/app/providers/CommandPaletteProvider';
import { useSearch } from '@/hooks/useSearch';
import { Avatar } from '@/components/ui/Avatar';
import type { PaletteCommand } from '@/app/providers/CommandPaletteProvider';
import type { SearchResultItem } from '@/hooks/useSearch';
import styles from './CommandPalette.module.css';

const RECENT_COMMANDS_KEY = 'dark_space_recent_commands';

function getRecentCommandIds(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_COMMANDS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

interface CommandGroup {
  label: string;
  items: (PaletteCommand | SearchResultItem)[];
}

function saveRecentCommands(commandIds: string[]): void {
  try {
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(commandIds.slice(0, 5)));
  } catch {
    // silently fail
  }
}

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  return t.includes(q);
}

function isSearchResult(item: PaletteCommand | SearchResultItem): item is SearchResultItem {
  return 'subtitle' in item && 'avatar_url' in item;
}

export function CommandPalette() {
  const { isOpen, close, commands } = useCommandPaletteContext();
  const navigate = useNavigate();
  const containerRef = useFocusTrap(isOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { results: searchResults, isLoading: searchLoading, search } = useSearch();

  // Reset state on open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  // Debounced search
  useEffect(() => {
    if (query.trim().length >= 2) {
      search(query);
    }
  }, [query, search]);

  // Build default commands
  const defaultCommands = useMemo<PaletteCommand[]>(() => {
    return [
      { id: 'nav-home', label: 'Home', category: 'navigation',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>,
        action: () => navigate('/'),
      },
      { id: 'nav-ai', label: 'AI', category: 'navigation',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.912 5.813a2 2 0 001.275 1.275L21 12l-5.813 1.912a2 2 0 00-1.275 1.275L12 21l-1.912-5.813a2 2 0 00-1.275-1.275L3 12l5.813-1.912a2 2 0 001.275-1.275L12 3z" /></svg>,
        action: () => navigate('/ai'),
      },
      { id: 'nav-channels', label: 'Channels', category: 'navigation',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" /></svg>,
        action: () => navigate('/channels'),
      },
      { id: 'nav-dm', label: 'Messages', category: 'navigation',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>,
        action: () => navigate('/dm'),
      },
      { id: 'nav-files', label: 'Files', category: 'navigation',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>,
        action: () => navigate('/files'),
      },
      { id: 'nav-tasks', label: 'Tasks', category: 'navigation',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></svg>,
        action: () => navigate('/tasks'),
      },
      { id: 'nav-projects', label: 'Projects', category: 'navigation',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>,
        action: () => navigate('/projects'),
      },
      { id: 'nav-calendar', label: 'Calendar', category: 'navigation',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>,
        action: () => navigate('/calendar'),
      },
      { id: 'nav-automation', label: 'Automation', category: 'navigation',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>,
        action: () => navigate('/automation'),
      },
      { id: 'nav-notifications', label: 'Notifications', category: 'navigation',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></svg>,
        action: () => navigate('/notifications'),
      },
      { id: 'nav-settings', label: 'Settings', category: 'navigation',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" /></svg>,
        action: () => navigate('/settings'),
      },
      { id: 'nav-profile', label: 'Profile', category: 'navigation',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>,
        action: () => navigate('/profile'),
      },
      { id: 'cmd-create-channel', label: 'Create Channel', category: 'command',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></svg>,
        action: () => navigate('/channels'),
      },
      { id: 'cmd-new-dm', label: 'New Message', category: 'command',
        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></svg>,
        action: () => navigate('/dm'),
      },
    ];
  }, [navigate]);

  const allCommands = useMemo(() => {
    return [...defaultCommands, ...commands];
  }, [defaultCommands, commands]);

  const hasQuery = query.trim().length > 0;

  // Filter and group — commands + search results when typing
  const groups = useMemo<CommandGroup[]>(() => {
    const recentIds = getRecentCommandIds();

    if (!hasQuery) {
      const recentItems = recentIds
        .map((id) => allCommands.find((c) => c.id === id))
        .filter(Boolean) as PaletteCommand[];
      const navigationItems = allCommands.filter((c) => c.category === 'navigation');
      const commandItems = allCommands.filter((c) => c.category === 'command');

      const result: CommandGroup[] = [];
      if (recentItems.length > 0) {
        result.push({ label: 'Recent', items: recentItems.slice(0, 5) });
      }
      result.push({ label: 'Navigation', items: navigationItems });
      result.push({ label: 'Commands', items: commandItems });
      return result;
    }

    // When typing: filter commands AND show search results
    const filtered = allCommands.filter(
      (c) => fuzzyMatch(query, c.label) || (c.description && fuzzyMatch(query, c.description)),
    );

    const navigationItems = filtered.filter((c) => c.category === 'navigation');
    const commandItems = filtered.filter((c) => c.category === 'command');

    const result: CommandGroup[] = [];
    if (navigationItems.length > 0) result.push({ label: 'Navigation', items: navigationItems });
    if (commandItems.length > 0) result.push({ label: 'Commands', items: commandItems });

    if (searchResults.length > 0) {
      result.push({ label: 'Search Results', items: searchResults });
    }

    return result;
  }, [query, hasQuery, allCommands, searchResults]);

  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Keep selectedIndex in bounds
  useEffect(() => {
    if (selectedIndex >= flatItems.length) {
      setSelectedIndex(Math.max(0, flatItems.length - 1));
    }
  }, [selectedIndex, flatItems.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    selectedEl?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleSelectItem = useCallback((item: PaletteCommand | SearchResultItem) => {
    if (isSearchResult(item)) {
      navigate(item.link);
    } else {
      item.action();
      const recent = getRecentCommandIds().filter((r) => r !== item.id);
      recent.unshift(item.id);
      saveRecentCommands(recent);
    }
    close();
  }, [navigate, close]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % Math.max(1, flatItems.length));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + flatItems.length) % Math.max(1, flatItems.length));
          break;
        case 'Enter':
          e.preventDefault();
          if (flatItems[selectedIndex]) {
            handleSelectItem(flatItems[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          close();
          break;
      }
    },
    [flatItems, selectedIndex, handleSelectItem, close],
  );

  if (!isOpen) return null;

  let itemIndex = -1;

  return (
    <Portal>
      <div
        ref={containerRef}
        className={styles.overlay}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
      >
        <div className={styles.backdrop} onClick={close} aria-hidden="true" />
        <div className={styles.palette}>
          <div className={styles.inputWrapper}>
            <svg className={styles.searchIcon} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              ref={inputRef}
              className={styles.input}
              type="text"
              placeholder="Search messages, channels, people, or commands..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleKeyDown}
              aria-label="Search"
              aria-activedescendant={flatItems[selectedIndex] ? `cmd-${flatItems.length > 0 ? (flatItems[selectedIndex] as PaletteCommand).id : ''}` : undefined}
            />
          </div>
          <div className={styles.list} ref={listRef} role="listbox">
            {flatItems.length === 0 ? (
              <div className={styles.empty}>
                {searchLoading ? 'Searching...' : 'No results found'}
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.label} className={styles.group}>
                  <div className={styles.groupLabel}>{group.label}</div>
                  {group.items.map((item) => {
                    itemIndex++;
                    const isSelected = itemIndex === selectedIndex;
                    const currentIndex = itemIndex;

                    if (isSearchResult(item)) {
                      return (
                        <button
                          key={`search-${item.id}`}
                          type="button"
                          className={`${styles.item} ${isSelected ? styles.itemSelected : ''}`}
                          role="option"
                          aria-selected={isSelected}
                          data-index={currentIndex}
                          onClick={() => handleSelectItem(item)}
                          onMouseEnter={() => setSelectedIndex(currentIndex)}
                        >
                          {item.avatar_url ? (
                            <Avatar src={item.avatar_url} name={item.title} size="sm" />
                          ) : (
                            <span className={styles.itemIcon}>
                              {item.type === 'message' ? (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
                              ) : item.type === 'channel' ? (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" /></svg>
                              ) : (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                              )}
                            </span>
                          )}
                          <div className={styles.itemContent}>
                            <span className={styles.itemLabel}>{item.title}</span>
                            <span className={styles.itemDescription}>
                              {item.type === 'message' ? 'message' : item.type === 'channel' ? 'channel' : 'user'}
                              {item.subtitle ? ` · ${item.subtitle}` : ''}
                            </span>
                          </div>
                        </button>
                      );
                    }

                    return (
                      <button
                        key={item.id}
                        id={`cmd-${item.id}`}
                        type="button"
                        className={`${styles.item} ${isSelected ? styles.itemSelected : ''}`}
                        role="option"
                        aria-selected={isSelected}
                        data-index={currentIndex}
                        onClick={() => handleSelectItem(item)}
                        onMouseEnter={() => setSelectedIndex(currentIndex)}
                      >
                        {item.icon && <span className={styles.itemIcon}>{item.icon}</span>}
                        <div className={styles.itemContent}>
                          <span className={styles.itemLabel}>{item.label}</span>
                          {item.description && (
                            <span className={styles.itemDescription}>{item.description}</span>
                          )}
                        </div>
                        {item.shortcut && (
                          <kbd className={styles.shortcut}>{item.shortcut}</kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          <div className={styles.footer}>
            <span className={styles.footerHint}>
              <kbd className={styles.footerKbd}>↑↓</kbd> Navigate
            </span>
            <span className={styles.footerHint}>
              <kbd className={styles.footerKbd}>↵</kbd> Select
            </span>
            <span className={styles.footerHint}>
              <kbd className={styles.footerKbd}>Esc</kbd> Close
            </span>
          </div>
        </div>
      </div>
    </Portal>
  );
}
