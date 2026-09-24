import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSearch, type SearchFilter, type SearchResultItem } from '@/hooks/useSearch';
import { useCommandPaletteContext } from '@/app/providers/CommandPaletteProvider';
import { Avatar } from '@/components/ui/Avatar';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatRelativeTime } from '@/utils';
import styles from './SearchModal.module.css';

interface SearchModalProps {
  open: boolean;
  onClose: () => void;
}

const FILTER_TABS: Array<{ id: SearchFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'messages', label: 'Messages' },
  { id: 'channels', label: 'Channels' },
  { id: 'users', label: 'Users' },
];

const GROUP_LABELS: Record<string, string> = {
  message: 'Messages',
  channel: 'Channels',
  user: 'People',
};

export function SearchModal({ open, onClose }: SearchModalProps) {
  const navigate = useNavigate();
  const { open: openPalette } = useCommandPaletteContext();
  const { query, results, isLoading, activeFilter, search, setFilter, clearSearch } = useSearch();
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [results]);

  const groupedResults = results.reduce<Record<string, SearchResultItem[]>>((acc, item) => {
    if (!acc[item.type]) acc[item.type] = [];
    acc[item.type].push(item);
    return acc;
  }, {});

  const flatResults = Object.values(groupedResults).flat();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.min(prev + 1, flatResults.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && highlightedIndex >= 0) {
        e.preventDefault();
        const item = flatResults[highlightedIndex];
        if (item) {
          handleSelect(item);
        }
      }
    },
    [flatResults, highlightedIndex],
  );

  const handleSelect = useCallback(
    (item: SearchResultItem) => {
      if (item.link) {
        navigate(item.link);
      }
      clearSearch();
      onClose();
    },
    [navigate, clearSearch, onClose],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      search(e.target.value);
    },
    [search],
  );

  const handleClear = useCallback(() => {
    clearSearch();
    inputRef.current?.focus();
  }, [clearSearch]);

  if (!open) return null;

  const hasQuery = query.trim().length > 0;
  const hasResults = results.length > 0;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Search">
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal}>
        <div className={styles.searchHeader}>
          <span className={styles.searchIcon}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className={styles.searchInput}
            type="search"
            placeholder="Search messages, channels, people..."
            value={query}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            aria-label="Search"
            aria-autocomplete="list"
            aria-controls="search-results"
            role="combobox"
          />
          <button
            className={styles.searchCommandButton}
            onClick={() => {
              onClose();
              openPalette();
            }}
            type="button"
            aria-label="Open command palette (Ctrl+K)"
          >
            <kbd className={styles.kbd}>Ctrl</kbd>
            <kbd className={styles.kbd}>K</kbd>
          </button>
          <button
            className={styles.searchCloseButton}
            onClick={onClose}
            type="button"
            aria-label="Close search"
          >
            Esc
          </button>
        </div>

        <div className={styles.filterTabs} role="tablist" aria-label="Search filters">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.id}
              className={`${styles.filterTab} ${activeFilter === tab.id ? styles.filterTabActive : ''}`}
              onClick={() => setFilter(tab.id)}
              role="tab"
              aria-selected={activeFilter === tab.id}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div
          className={styles.resultsList}
          ref={listRef}
          id="search-results"
          role="listbox"
          aria-label="Search results"
        >
          {isLoading ? (
            <div className={styles.skeletonGroup}>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={styles.skeletonItem}>
                  <Skeleton variant="circle" width={32} height={32} />
                  <div className={styles.skeletonContent}>
                    <Skeleton variant="text" width="50%" />
                    <Skeleton variant="text" width="80%" />
                  </div>
                </div>
              ))}
            </div>
          ) : !hasQuery ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="11" cy="11" r="8" />
                  <path d="M21 21l-4.35-4.35" />
                </svg>
              </div>
              <p className={styles.emptyTitle}>Search across messages, channels, and people</p>
              <p className={styles.emptyDescription}>Start typing to find what you&apos;re looking for.</p>
            </div>
          ) : !hasResults ? (
            <div className={styles.noResults}>
              <div className={styles.emptyIcon}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="11" cy="11" r="8" />
                  <path d="M21 21l-4.35-4.35" />
                </svg>
              </div>
              <p className={styles.emptyTitle}>
                No results for <span className={styles.noResultsQuery}>&apos;{query}&apos;</span>
              </p>
              <p className={styles.emptyDescription}>Try different keywords or check your spelling.</p>
            </div>
          ) : (
            Object.entries(groupedResults).map(([type, items]) => (
              <div key={type} className={styles.resultGroup} role="group" aria-label={GROUP_LABELS[type] || type}>
                <p className={styles.resultGroupLabel}>{GROUP_LABELS[type] || type}</p>
                {items.map((item) => {
                  const globalIndex = flatResults.indexOf(item);
                  return (
                    <div
                      key={item.id}
                      className={`${styles.resultItem} ${globalIndex === highlightedIndex ? styles.resultItemHighlighted : ''}`}
                      role="option"
                      aria-selected={globalIndex === highlightedIndex}
                      tabIndex={-1}
                      onClick={() => handleSelect(item)}
                      onMouseEnter={() => setHighlightedIndex(globalIndex)}
                    >
                      {item.type === 'user' ? (
                        <div className={styles.resultAvatar}>
                          <Avatar size="sm" src={item.avatar_url || undefined} name={item.title} />
                        </div>
                      ) : (
                        <div className={styles.resultIcon}>
                          {item.type === 'channel' ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                              <circle cx="9" cy="7" r="4" />
                              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                            </svg>
                          ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                            </svg>
                          )}
                        </div>
                      )}
                      <div className={styles.resultContent}>
                        <p className={styles.resultTitle}>{item.title}</p>
                        <p className={styles.resultSubtitle}>{item.subtitle}</p>
                      </div>
                      {item.created_at && (
                        <div className={styles.resultMeta}>
                          <span className={styles.resultTime}>{formatRelativeTime(item.created_at)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className={styles.keyboardHint}>
          <span className={styles.hintItem}>
            <kbd className={styles.kbd}>↑</kbd>
            <kbd className={styles.kbd}>↓</kbd>
            Navigate
          </span>
          <span className={styles.hintItem}>
            <kbd className={styles.kbd}>↵</kbd>
            Select
          </span>
          <span className={styles.hintItem}>
            <kbd className={styles.kbd}>Esc</kbd>
            Close
          </span>
        </div>
      </div>
    </div>
  );
}
