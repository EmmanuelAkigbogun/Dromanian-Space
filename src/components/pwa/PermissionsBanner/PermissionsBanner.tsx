import { useEffect, useState } from 'react';
import { enablePush, pushState, type PushState } from '@/lib/push';
import { CHAT_ONLY, isIOS, isStandalone } from '@/lib/pwa';
import styles from './PermissionsBanner.module.css';

type MediaState = 'granted' | 'prompt' | 'denied' | 'unsupported';

const SNOOZE_KEY = 'darkspace:permissions-snoozed-until';
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

function snoozed(): boolean {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now();
  } catch {
    return false;
  }
}

async function mediaState(): Promise<MediaState> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  try {
    const [camera, microphone] = await Promise.all([
      navigator.permissions.query({ name: 'camera' as PermissionName }),
      navigator.permissions.query({ name: 'microphone' as PermissionName }),
    ]);
    if (camera.state === 'denied' || microphone.state === 'denied') return 'denied';
    return camera.state === 'granted' && microphone.state === 'granted' ? 'granted' : 'prompt';
  } catch {
    // Browsers without camera permission queries: remember a past grant.
    try {
      return localStorage.getItem('darkspace:media-granted') ? 'granted' : 'prompt';
    } catch {
      return 'prompt';
    }
  }
}

/**
 * Asks, clearly and once per device, for what the app needs to work like a
 * phone app: notifications (delivered even while the app is closed) and, in
 * the installed app, the camera and microphone for calls.
 */
export function PermissionsBanner() {
  const [push, setPush] = useState<PushState | null>(null);
  const [media, setMedia] = useState<MediaState | null>(null);
  const [hidden, setHidden] = useState(snoozed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    pushState().then((s) => !cancelled && setPush(s)).catch(() => !cancelled && setPush('unavailable'));
    if (CHAT_ONLY) mediaState().then((s) => !cancelled && setMedia(s));
    return () => {
      cancelled = true;
    };
  }, []);

  // iPhone and iPad deliver notifications only to the installed app.
  const iosBrowser = isIOS() && !isStandalone() && !window.darkspaceDesktop;
  const askPush = push === 'off';
  const askMedia = media === 'prompt';
  const blocked = [push === 'denied' && 'notifications', media === 'denied' && 'camera and microphone'].filter(Boolean) as string[];

  if (hidden || push === null || (!askPush && !askMedia && !blocked.length && !iosBrowser)) return null;

  async function allow() {
    setBusy(true);
    setError('');
    try {
      if (askPush) setPush(await enablePush());
      if (askMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          stream.getTracks().forEach((t) => t.stop());
          try {
            localStorage.setItem('darkspace:media-granted', '1');
          } catch {
            /* remembered only for browsers without permission queries */
          }
          setMedia('granted');
        } catch (e) {
          setMedia(e instanceof DOMException && e.name === 'NotAllowedError' ? 'denied' : 'unsupported');
        }
      }
    } catch {
      setError('That did not work. Try again, or turn it on later from Notifications.');
    } finally {
      setBusy(false);
    }
  }

  function later() {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    } catch {
      /* hidden for this visit only */
    }
    setHidden(true);
  }

  const wants = [askPush && 'notifications', askMedia && 'camera and microphone'].filter(Boolean) as string[];

  return (
    <div className={styles.banner} role="region" aria-label="App permissions">
      <span className={styles.icon} aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      </span>
      <div className={styles.text}>
        {wants.length > 0 ? (
          <>
            <strong>Turn on {wants.join(' and ')}</strong>
            <span>
              {askPush && 'Get new messages, mentions and tasks even when Darkspace is closed or in the background. '}
              {askMedia && 'Allow the camera and microphone so calls connect straight away.'}
            </span>
          </>
        ) : iosBrowser ? (
          <>
            <strong>Install Darkspace to get notifications</strong>
            <span>On iPhone and iPad, tap Share, then Add to Home Screen, and open Darkspace from there.</span>
          </>
        ) : (
          <>
            <strong>{blocked.join(' and ')} blocked</strong>
            <span>Allow {blocked.join(' and ')} for Darkspace in your phone or browser settings, then reopen the app.</span>
          </>
        )}
        {error && <span className={styles.error} role="alert">{error}</span>}
      </div>
      <div className={styles.actions}>
        {wants.length > 0 && (
          <button type="button" className={styles.allow} onClick={() => void allow()} disabled={busy}>
            {busy ? 'Waiting…' : 'Turn on'}
          </button>
        )}
        <button type="button" className={styles.later} onClick={later}>
          {wants.length > 0 ? 'Not now' : 'Dismiss'}
        </button>
      </div>
    </div>
  );
}
