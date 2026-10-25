import { useState } from 'react';
import { useInstallPrompt } from '@/lib/pwa';
import styles from './InstallApp.module.css';

/**
 * "Install app" for phones and desktop browsers. Hidden once installed, in
 * the desktop app, and where the browser offers no way to install.
 */
export function InstallApp() {
  const { canPrompt, needsIOSInstructions, install } = useInstallPrompt();
  const [showSteps, setShowSteps] = useState(false);

  if (!canPrompt && !needsIOSInstructions) return null;

  return (
    <div className={styles.installApp}>
      <button
        type="button"
        className={styles.button}
        onClick={() => (canPrompt ? void install() : setShowSteps((v) => !v))}
        aria-expanded={needsIOSInstructions ? showSteps : undefined}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
        </svg>
        Install app
      </button>
      {showSteps && needsIOSInstructions && (
        <div className={styles.steps} role="dialog" aria-label="Install on iPhone or iPad">
          <p className={styles.stepsTitle}>Install Darkspace on this device</p>
          <ol>
            <li>
              Tap <strong>Share</strong>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
              </svg>
              in Safari's toolbar.
            </li>
            <li>Choose <strong>Add to Home Screen</strong>.</li>
            <li>Open Darkspace from your Home Screen, go to Notifications and tap <strong>Enable push</strong>.</li>
          </ol>
          <p className={styles.note}>iPhone and iPad only deliver notifications to installed apps (iOS 16.4 or later).</p>
          <button type="button" className={styles.done} onClick={() => setShowSteps(false)}>
            Got it
          </button>
        </div>
      )}
    </div>
  );
}
