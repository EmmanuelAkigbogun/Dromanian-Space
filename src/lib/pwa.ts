// Installable app (PWA) support: registers the push service worker, removes
// workers from older builds that cached the app, and keeps the browser's
// install prompt so the app can offer an "Install app" button.
import { useEffect, useState } from 'react';

const WORKER_URL = '/sw.js';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// The installed phone/tablet app is a chat app: conversations plus the
// notification settings push needs. Everything else stays in the browser.
export const CHAT_ONLY = typeof window !== 'undefined' && !window.darkspaceDesktop && isStandalone();
export const CHAT_HOME = '/dm';
export const chatOnlyPath = (path: string) => /^\/(dm|channels|threads|messages|notifications|invitations|profile)(\/|$)/.test(path);

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

/** Called once at startup. */
export function initPwa(): void {
  if (typeof window === 'undefined' || window.darkspaceDesktop) return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  void (async () => {
    try {
      // Older builds registered caching workers; they could serve stale code.
      for (const registration of await navigator.serviceWorker.getRegistrations()) {
        const script = registration.active?.scriptURL ?? registration.installing?.scriptURL ?? '';
        if (!script.endsWith(WORKER_URL)) await registration.unregister();
      }
      if ('caches' in window) for (const name of await caches.keys()) await caches.delete(name);
      await navigator.serviceWorker.register(WORKER_URL, { scope: '/' });
    } catch {
      /* the app works without a worker; only install and push need it */
    }
  })();
}

export function useInstallPrompt() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const installed = typeof window !== 'undefined' && isStandalone();
  return {
    installed,
    /** Chrome, Edge and Android offer a one-click install. */
    canPrompt: !installed && deferredPrompt !== null,
    /** iOS installs through Share → Add to Home Screen. */
    needsIOSInstructions: !installed && !window.darkspaceDesktop && isIOS(),
    async install(): Promise<boolean> {
      if (!deferredPrompt) return false;
      const prompt = deferredPrompt;
      deferredPrompt = null;
      await prompt.prompt();
      const choice = await prompt.userChoice;
      notify();
      return choice.outcome === 'accepted';
    },
  };
}
