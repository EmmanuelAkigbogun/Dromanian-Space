import { useState, useRef, useEffect } from 'react';
import { useCallContextSafe } from '@/app/providers/CallProvider/CallProvider';
import styles from './CallButton.module.css';

interface CallButtonProps {
  channelId?: string;
  conversationId?: string;
  targetUserId?: string;
  participantIds?: string[];
  callType?: 'direct' | 'group' | 'channel';
}

export function CallButton({ channelId, targetUserId, participantIds, callType = 'direct' }: CallButtonProps) {
  const callCtx = useCallContextSafe();

  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!callCtx || callCtx.callScreen !== 'none') return null;
  const { startCall } = callCtx;

  const handleCall = (withVideo: boolean) => {
    setShowDropdown(false);
    if (callType === 'channel' && channelId) {
      startCall(channelId, 'channel', participantIds, withVideo);
    } else if (targetUserId) {
      startCall(targetUserId, callType, participantIds, withVideo);
    }
  };

  return (
    <div className={styles.container} ref={dropdownRef}>
      <button
        type="button"
        className={styles.callButton}
        onClick={() => setShowDropdown(!showDropdown)}
        aria-label="Start call"
        title="Start call"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={styles.chevron}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {showDropdown && (
        <div className={styles.dropdown}>
          <button type="button" className={styles.dropdownItem} onClick={() => handleCall(false)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
            <span>Voice Call</span>
          </button>
          <button type="button" className={styles.dropdownItem} onClick={() => handleCall(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 7l-7 5 7 5V7z" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            <span>Video Call</span>
          </button>
        </div>
      )}
    </div>
  );
}
