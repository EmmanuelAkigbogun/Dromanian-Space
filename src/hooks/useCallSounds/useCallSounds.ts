import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallScreen } from '@/types';

type BrowserAudioContext = AudioContext & { close: () => Promise<void> };

export function useCallSounds(callScreen: CallScreen) {
  const [soundsEnabled, setSoundsEnabled] = useState(true);
  const contextRef = useRef<BrowserAudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeNodesRef = useRef<Set<AudioScheduledSourceNode>>(new Set());
  const previousScreenRef = useRef<CallScreen>('none');
  const soundGenerationRef = useRef(0);
  const desiredToneRef = useRef<'incoming' | 'outgoing' | null>(null);

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
    if (context.state !== 'running') {
      try {
        await context.resume();
      } catch {
        return false;
      }
    }
    return context.state === 'running';
  }, [getContext]);

  const stopSounds = useCallback(() => {
    desiredToneRef.current = null;
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
    desiredToneRef.current = kind;
    const generation = soundGenerationRef.current;
    if (!(await unlockAudio())) return;
    if (generation !== soundGenerationRef.current || desiredToneRef.current !== kind) return;
    // A bright, layered three-step cadence stays audible from across a room
    // without changing the remote participant volume during the call.
    const pulse = kind === 'incoming'
      ? () => {
          playChord([523.25, 659.25], 250, 0, 0.24);
          playChord([587.33, 739.99], 250, 285, 0.24);
          playChord([659.25, 783.99], 360, 570, 0.3);
        }
      : () => playChord([425, 510], 950, 0, 0.16);
    pulse();
    timerRef.current = setInterval(pulse, kind === 'incoming' ? 2_450 : 3_000);
  }, [playChord, stopSounds, unlockAudio]);

  useEffect(() => {
    const desktop = window.darkspaceDesktop;
    if (!desktop) return;
    return desktop.onSoundsChanged(setSoundsEnabled);
  }, []);

  useEffect(() => {
    const unlockFromInteraction = () => {
      void unlockAudio().then((ready) => {
        const desiredTone = desiredToneRef.current;
        if (ready && desiredTone && !timerRef.current) void startRepeatingTone(desiredTone);
      });
    };
    window.addEventListener('pointerdown', unlockFromInteraction, { capture: true });
    window.addEventListener('keydown', unlockFromInteraction, { capture: true });
    window.addEventListener('touchstart', unlockFromInteraction, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', unlockFromInteraction, { capture: true });
      window.removeEventListener('keydown', unlockFromInteraction, { capture: true });
      window.removeEventListener('touchstart', unlockFromInteraction, { capture: true });
    };
  }, [startRepeatingTone, unlockAudio]);

  useEffect(() => {
    const previous = previousScreenRef.current;
    previousScreenRef.current = callScreen;
    stopSounds();

    if (!soundsEnabled) return stopSounds;

    if (callScreen === 'incoming' || callScreen === 'outgoing') {
      void startRepeatingTone(callScreen);
    } else if (callScreen === 'active' && previous !== 'active') {
      const generation = soundGenerationRef.current;
      void unlockAudio().then((ready) => {
        if (!ready || generation !== soundGenerationRef.current) return;
        playChord([660], 90, 0, 0.06);
        playChord([880], 120, 105, 0.06);
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
  }, [callScreen, playChord, soundsEnabled, startRepeatingTone, stopSounds, unlockAudio]);

  useEffect(() => () => {
    stopSounds();
    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== 'closed') void context.close();
  }, [stopSounds]);

  return { unlockAudio };
}
