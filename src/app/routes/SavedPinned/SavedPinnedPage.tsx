import { useState } from 'react';
import { SavedMessagesPanel } from '@/components/productivity/SavedMessagesPanel/SavedMessagesPanel';
import { PinnedMessagesPanel } from '@/components/message/PinnedMessagesPanel';
import styles from './SavedPinned.module.css';

type Tab = 'saved' | 'pinned';

export function SavedPinnedPage() {
  const [activeTab, setActiveTab] = useState<Tab>('saved');

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h2 className={styles.pageTitle}>Saved & Pinned Messages</h2>
      </div>

      <div className={styles.tabs}>
        <button
          type="button"
          className={`${styles.tab} ${activeTab === 'saved' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('saved')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
          </svg>
          Saved
        </button>
        <button
          type="button"
          className={`${styles.tab} ${activeTab === 'pinned' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('pinned')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L12 12" />
            <path d="M12 2L9 5" />
            <path d="M12 2L15 5" />
            <path d="M5 10H19L18 22H6L5 10Z" />
          </svg>
          Pinned
        </button>
      </div>

      <div className={styles.content}>
        {activeTab === 'saved' ? <SavedMessagesPanel /> : <PinnedMessagesPanel />}
      </div>
    </div>
  );
}
