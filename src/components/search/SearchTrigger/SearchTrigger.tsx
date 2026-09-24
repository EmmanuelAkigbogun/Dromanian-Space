import { useState } from 'react';
import { SearchModal } from '../SearchModal/SearchModal';
import styles from './SearchTrigger.module.css';

export function SearchTrigger() {
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  return (
    <>
      <div className={styles.searchButton}>
        <button
          className={styles.searchMain}
          onClick={() => setIsSearchOpen(true)}
          type="button"
          aria-label="Open search"
        >
          <span className={styles.searchIcon}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
          </span>
          <span className={styles.searchPlaceholder}>Search...</span>
        </button>
      </div>

      <button
        className={styles.mobileSearchButton}
        onClick={() => setIsSearchOpen(true)}
        type="button"
        aria-label="Open search"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
      </button>

      <SearchModal open={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
    </>
  );
}
