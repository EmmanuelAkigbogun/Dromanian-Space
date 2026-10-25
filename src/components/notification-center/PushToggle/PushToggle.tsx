import { useEffect, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { disablePush, enablePush, pushState, type PushState } from '@/lib/push';
import styles from './PushToggle.module.css';

const HINTS: Partial<Record<PushState, string>> = {
  on: 'Push is on for this browser: you are notified of task assignments and approvals even when Darkspace is closed.',
  off: 'Get a system notification when a task is assigned to you or needs your approval, even when Darkspace is closed.',
  denied: 'Notifications are blocked for this site. Allow them in your browser’s site settings, then reload.',
};

/** Turns Web Push on or off for this browser. Hidden where push cannot work. */
export function PushToggle() {
  const { toast } = useToast();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    pushState().then((s) => !cancelled && setState(s)).catch(() => !cancelled && setState('unavailable'));
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === null || state === 'unsupported' || state === 'unavailable') return null;

  async function toggle() {
    setBusy(true);
    try {
      const next = state === 'on' ? await disablePush() : await enablePush();
      setState(next);
      if (next === 'on') toast({ variant: 'success', description: 'Push notifications are on for this browser.' });
      else if (next === 'denied') toast({ variant: 'error', description: 'Notifications are blocked for this site in your browser settings.' });
    } catch {
      toast({ variant: 'error', description: 'Push notifications could not be changed. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.pushToggle}>
      <button
        type="button"
        className={`${styles.button} ${state === 'on' ? styles.on : ''}`}
        onClick={() => void toggle()}
        disabled={busy || state === 'denied'}
        aria-pressed={state === 'on'}
        title={HINTS[state]}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {state === 'on' ? 'Push on' : state === 'denied' ? 'Push blocked' : 'Enable push'}
      </button>
    </div>
  );
}
