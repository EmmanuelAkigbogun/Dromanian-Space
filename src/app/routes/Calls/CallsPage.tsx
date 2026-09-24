import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { NewCallPage } from '@/app/routes/NewCall/NewCallPage';
import { CallHistoryPage } from '@/app/routes/CallHistory/CallHistoryPage';
import styles from './Calls.module.css';

type Tab = 'new' | 'history';

export function CallsPage() {
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    if (location.pathname.startsWith('/call-history')) return 'history';
    return 'new';
  });

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h2 className={styles.pageTitle}>Calls</h2>
      </div>

      <div className={styles.tabs}>
        <button
          type="button"
          className={`${styles.tab} ${activeTab === 'new' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('new')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
          New Call
        </button>
        <button
          type="button"
          className={`${styles.tab} ${activeTab === 'history' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('history')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3v5h5" />
            <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
            <polyline points="12 7 12 12 15 14" />
          </svg>
          History
        </button>
      </div>

      <div className={styles.content}>
        {activeTab === 'new' ? <NewCallPage /> : <CallHistoryPage />}
      </div>
    </div>
  );
}
