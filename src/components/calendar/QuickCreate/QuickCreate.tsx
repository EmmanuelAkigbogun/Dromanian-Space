import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Anchor, CalendarDraft } from '../TimeGrid/TimeGrid';
import { describeRange } from '../calendarUtils';
import { Portal } from '@/lib/overlay/Portal';
import styles from './QuickCreate.module.css';

interface QuickCreateProps {
  draft: CalendarDraft;
  anchor: Anchor;
  onSave: (title: string) => Promise<boolean>;
  onMoreOptions: (title: string) => void;
  onCancel: () => void;
}

const WIDTH = 340;
const MARGIN = 12;

/**
 * The small popup Google Calendar shows after clicking or dragging on the
 * grid: type a title and press Enter, or open the full form.
 */
export function QuickCreate({ draft, anchor, onSave, onMoreOptions, onCancel }: QuickCreateProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [position, setPosition] = useState({ top: anchor.y, left: anchor.x });

  // Sit beside the pointer, flipped and clamped to stay on screen.
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 180;
    let left = anchor.x + MARGIN;
    if (left + WIDTH > window.innerWidth - MARGIN) left = anchor.x - WIDTH - MARGIN;
    left = Math.max(MARGIN, left);
    let top = anchor.y - height / 2;
    top = Math.min(Math.max(MARGIN, top), window.innerHeight - height - MARGIN);
    setPosition({ top, left });
    inputRef.current?.focus();
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    // Wait a frame so the pointer-up that opened the popup doesn't close it.
    const id = window.setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError('');
    const ok = await onSave(title.trim() || '(No title)');
    setSaving(false);
    if (!ok) setError('The event could not be saved. Try again.');
  }

  return (
    <Portal>
    <div
      ref={ref}
      className={styles.popover}
      style={{ top: position.top, left: position.left, width: WIDTH }}
      role="dialog"
      aria-label="New event"
    >
      <button type="button" className={styles.close} onClick={onCancel} aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
      <input
        ref={inputRef}
        className={styles.title}
        placeholder="Add title"
        value={title}
        maxLength={300}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className={styles.when}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
        <span>{describeRange(draft.start, draft.end, draft.allDay)}</span>
      </div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.more} onClick={() => onMoreOptions(title.trim())}>
          More options
        </button>
        <button type="button" className={styles.save} onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
    </Portal>
  );
}
