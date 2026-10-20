import { useCallback, useEffect, useRef } from 'react';
import type { CallScreen } from '@/types';

type BrowserAudioContext = AudioContext & { close: () => Promise<void> };

export function useCallSounds(callScreen: CallScreen) {
  const contextRef = useRef<BrowserAudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeNodesRef = useRef<Set<AudioScheduledSourceNode>>(new Set());
  const previousScreenRef = useRef<CallScreen>('none');
  const soundGenerationRef = useRef(0);

  const getContext = useCallback((): BrowserAudioContext | null => {
    if (typeof window === 'undefined') return null;
    if (!contextRef.current) {
      const Context = window.AudioContext
        ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return null;
      contextRef.current = new Context() as BrowserAudioContext;
    }
    return contextRef.current;
  }, []);

  const unlockAudio = useCallback(async (): Promise<boolean> => {
    const context = getContext();
    if (!context) return false;
    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        return false;
      }
    }
    return context.state === 'running';
  }, [getContext]);

  const stopSounds = useCallback(() => {
    soundGenerationRef.current += 1;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    activeNodesRef.current.forEach((node) => {
      try { node.stop(); } catch { /* already stopped */ }
      try { node.disconnect(); } catch { /* already disconnected */ }
    });
    activeNodesRef.current.clear();
  }, []);

  const playChord = useCallback((frequencies: number[], durationMs: number, delayMs = 0, volume = 0.045) => {
    const context = getContext();
    if (!context || context.state !== 'running') return;

    const startsAt = context.currentTime + delayMs / 1000;
    const endsAt = startsAt + durationMs / 1000;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(volume, startsAt + 0.018);
    gain.gain.setValueAtTime(volume, Math.max(startsAt + 0.019, endsAt - 0.035));
    gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);
    gain.connect(context.destination);

    for (const frequency of frequencies) {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, startsAt);
      oscillator.connect(gain);
      activeNodesRef.current.add(oscillator);
      oscillator.onended = () => {
        activeNodesRef.current.delete(oscillator);
        try { oscillator.disconnect(); } catch { /* already disconnected */ }
        if (activeNodesRef.current.size === 0) {
          try { gain.disconnect(); } catch { /* already disconnected */ }
        }
      };
      oscillator.start(startsAt);
      oscillator.stop(endsAt + 0.01);
    }
  }, [getContext]);

  const startRepeatingTone = useCallback(async (kind: 'incoming' | 'outgoing') => {
    stopSounds();
    const generation = soundGenerationRef.current;
    if (!(await unlockAudio())) return;
    if (generation !== soundGenerationRef.current) return;
    const pulse = kind === 'incoming'
      ? () => {
          playChord([440, 480], 650, 0, 0.04);
          playChord([440, 480], 650, 850, 0.04);
        }
      : () => playChord([425], 950, 0, 0.04);
    pulse();
    timerRef.current = setInterval(pulse, kind === 'incoming' ? 3_200 : 3_000);
  }, [playChord, stopSounds, unlockAudio]);

  useEffect(() => {
    const unlockFromInteraction = () => { void unlockAudio(); };
    window.addEventListener('pointerdown', unlockFromInteraction, { capture: true });
    window.addEventListener('keydown', unlockFromInteraction, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlockFromInteraction, { capture: true });
      window.removeEventListener('keydown', unlockFromInteraction, { capture: true });
    };
  }, [unlockAudio]);

  useEffect(() => {
    const previous = previousScreenRef.current;
    previousScreenRef.current = callScreen;
    stopSounds();

    if (callScreen === 'incoming' || callScreen === 'outgoing') {
      void startRepeatingTone(callScreen);
    } else if (callScreen === 'active' && previous !== 'active') {
      const generation = soundGenerationRef.current;
      void unlockAudio().then((ready) => {
        if (!ready || generation !== soundGenerationRef.current) return;
        playChord([660], 90, 0, 0.04);
        playChord([880], 120, 105, 0.04);
      });
    } else if (callScreen === 'none' && previous === 'active') {
      const generation = soundGenerationRef.current;
      void unlockAudio().then((ready) => {
        if (!ready || generation !== soundGenerationRef.current) return;
        playChord([520], 90, 0, 0.035);
        playChord([360], 150, 110, 0.035);
      });
    }

    return stopSounds;
  }, [callScreen, playChord, startRepeatingTone, stopSounds, unlockAudio]);

  useEffect(() => () => {
    stopSounds();
    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== 'closed') void context.close();
  }, [stopSounds]);

  return { unlockAudio };
}
