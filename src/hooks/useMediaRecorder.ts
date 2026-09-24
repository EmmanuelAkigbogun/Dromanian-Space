import { useCallback, useEffect, useRef, useState } from 'react';

interface UseMediaRecorderResult {
  recording: boolean;
  duration: number;
  error: string | null;
  start: (withVideo?: boolean) => Promise<boolean>;
  stop: () => Promise<Blob | null>;
  cancel: () => void;
}

function pickMimeType(withVideo: boolean): string | null {
  const candidates = withVideo
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  if (typeof MediaRecorder === 'undefined') return null;
  for (const candidate of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // candidate not recognized
    }
  }
  return null;
}

export function useMediaRecorder(onError?: (message: string) => void): UseMediaRecorderResult {
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const startTimeRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      clearTimer();
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
      stopTracks();
    };
  }, [clearTimer, stopTracks]);

  const fail = useCallback(
    (msg: string) => {
      setError(msg);
      onError?.(msg);
      setRecording(false);
      clearTimer();
      stopTracks();
    },
    [onError, clearTimer, stopTracks],
  );

  const start = useCallback(
    async (withVideo = false): Promise<boolean> => {
      if (recording) return false;
      if (
        typeof window === 'undefined' ||
        typeof MediaRecorder === 'undefined' ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        fail('Recording is not supported in this browser');
        return false;
      }
      setError(null);
      setDuration(0);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: withVideo ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
        });
        streamRef.current = stream;
        const mimeType = pickMimeType(withVideo);
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        recorderRef.current = recorder;
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onerror = () => fail('Recording failed');
        recorder.start();
        setRecording(true);
        startTimeRef.current = Date.now();
        timerRef.current = window.setInterval(() => {
          setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }, 500);
        return true;
      } catch {
        fail('Microphone access was denied');
        return false;
      }
    },
    [recording, fail],
  );

  const stop = useCallback((): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      stopTracks();
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      recorder.onstop = () => {
        clearTimer();
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];
        stopTracks();
        resolve(blob);
      };
      recorder.stop();
    });
  }, [clearTimer, stopTracks]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    clearTimer();
    setRecording(false);
    chunksRef.current = [];
    stopTracks();
  }, [clearTimer, stopTracks]);

  return { recording, duration, error, start, stop, cancel };
}
