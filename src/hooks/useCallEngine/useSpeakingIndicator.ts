import { useEffect, useRef, useState, useCallback } from 'react';

const SPEAKING_THRESHOLD = 0.015;
const POLL_INTERVAL_MS = 150;
const DEBOUNCE_MS = 300;

export function useSpeakingIndicator(remoteStreams: Map<string, MediaStream>) {
  const [speakingUsers, setSpeakingUsers] = useState<Set<string>>(new Set());
  // FIX: newer TypeScript versions made typed arrays generic over their
  // backing buffer (`Float32Array<TArrayBuffer extends ArrayBufferLike>`).
  // The DOM lib's `AnalyserNode.getFloatFrequencyData()` expects specifically
  // `Float32Array<ArrayBuffer>`. A bare `Float32Array` here can get inferred
  // as the wider `Float32Array<ArrayBufferLike>`, which no longer matches -
  // pinning the generic explicitly avoids that mismatch.
  const analyzersRef = useRef<Map<string, { analyzer: AnalyserNode; dataArray: Float32Array<ArrayBuffer>; ctx: AudioContext }>>(new Map());
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const cleanup = useCallback(() => {
    analyzersRef.current.forEach(({ analyzer, ctx }) => {
      try {
        analyzer.disconnect();
        ctx.close();
      } catch { /* already closed */ }
    });
    analyzersRef.current.clear();
    debounceTimersRef.current.forEach(clearTimeout);
    debounceTimersRef.current.clear();
  }, []);

  // Incrementally create/remove analyzers only for users who were actually
  // added/removed from remoteStreams. This part was already correct.
  useEffect(() => {
    const currentStreams = new Map(remoteStreams);

    currentStreams.forEach((stream, userId) => {
      if (analyzersRef.current.has(userId)) return;
      try {
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyzer = ctx.createAnalyser();
        analyzer.fftSize = 256;
        source.connect(analyzer);
        const dataArray = new Float32Array(analyzer.frequencyBinCount);
        analyzersRef.current.set(userId, { analyzer, dataArray, ctx });
      } catch { /* AudioContext failed */ }
    });

    analyzersRef.current.forEach((_entry, userId) => {
      if (!currentStreams.has(userId)) {
        try {
          _entry.analyzer.disconnect();
          _entry.ctx.close();
        } catch { /* already closed */ }
        analyzersRef.current.delete(userId);
      }
    });
  }, [remoteStreams]);

  useEffect(() => {
    if (analyzersRef.current.size === 0) return;

    const interval = setInterval(() => {
      const nowSpeaking = new Set<string>();

      analyzersRef.current.forEach(({ analyzer, dataArray }, userId) => {
        analyzer.getFloatFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] + 140) / 140;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const isAboveThreshold = rms > SPEAKING_THRESHOLD;

        if (isAboveThreshold) {
          nowSpeaking.add(userId);
          const timer = debounceTimersRef.current.get(userId);
          if (timer) {
            clearTimeout(timer);
            debounceTimersRef.current.delete(userId);
          }
        } else {
          if (!debounceTimersRef.current.has(userId)) {
            // FIX: previously all timers scheduled within the same 150ms poll
            // tick shared one `nowNotSpeaking` Set via closure, so independent
            // per-user timeouts (each firing ~300ms later) mutated and read
            // the same object. Harmless in outcome but confusing and fragile;
            // each timer now only ever touches its own userId.
            debounceTimersRef.current.set(
              userId,
              setTimeout(() => {
                debounceTimersRef.current.delete(userId);
                setSpeakingUsers((prev) => {
                  if (!prev.has(userId)) return prev;
                  const next = new Set(prev);
                  next.delete(userId);
                  return next;
                });
              }, DEBOUNCE_MS),
            );
          }
        }
      });

      if (nowSpeaking.size > 0) {
        setSpeakingUsers((prev) => {
          const next = new Set(prev);
          nowSpeaking.forEach((id) => next.add(id));
          return next;
        });
      }
    }, POLL_INTERVAL_MS);

    // FIX: this used to also call the full `cleanup()` here, which closes
    // EVERY participant's AudioContext/analyzer. Because this effect depends
    // on `remoteStreams`, and that Map gets a new reference on every single
    // track arrival (not just when a call actually ends), any one
    // participant's video/audio track showing up mid-call would blow away and
    // rebuild the speaking-indicator pipeline for ALL participants - visible
    // as the active-speaker highlight flickering/resetting, especially right
    // around call setup. Real teardown now only happens on unmount, below.
    return () => clearInterval(interval);
  }, [remoteStreams]);

  // Full teardown only on unmount of the hook itself.
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return speakingUsers;
}