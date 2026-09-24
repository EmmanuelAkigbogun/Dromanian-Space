import { useState, useRef, useEffect, useCallback } from 'react';
import { usePresence, type PresenceStatus } from '@/hooks/usePresence';
import { PresenceIndicator } from '@/components/presence/PresenceIndicator';
import styles from './StatusPicker.module.css';

interface StatusOption {
  value: PresenceStatus | null;
  label: string;
}

const STATUS_OPTIONS: StatusOption[] = [
  { value: 'online', label: 'Online' },
  { value: 'away', label: 'Away' },
  { value: 'busy', label: 'Busy' },
  { value: 'invisible', label: 'Invisible' },
  { value: null, label: 'Reset to Auto' },
];

interface StatusPickerProps {
  className?: string;
}

export function StatusPicker({ className }: StatusPickerProps) {
  const { myStatus, setMyStatus } = usePresence();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleSelect = useCallback(
    (status: PresenceStatus | null) => {
      setMyStatus(status);
      setIsOpen(false);
    },
    [setMyStatus],
  );

  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const classes = [styles.container, className].filter(Boolean).join(' ');

  return (
    <div ref={containerRef} className={classes}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        <PresenceIndicator status={myStatus} size="sm" />
        <span className={styles.triggerLabel}>Set Status</span>
      </button>

      {isOpen && (
        <div className={styles.dropdown} role="listbox" aria-label="Set your status">
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.label}
              type="button"
              className={styles.option}
              role="option"
              aria-selected={
                option.value === myStatus || (option.value === null && myStatus === 'online')
              }
              onClick={() => handleSelect(option.value)}
            >
              <PresenceIndicator
                status={option.value ?? 'online'}
                size="sm"
              />
              <span className={styles.optionLabel}>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
