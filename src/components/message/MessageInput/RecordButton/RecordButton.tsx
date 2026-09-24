import { useState, useRef, useEffect, useCallback } from 'react';
import { useMediaRecorder } from '@/hooks/useMediaRecorder';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { Portal } from '@/lib/overlay/Portal';
import styles from './RecordButton.module.css';

type RecordMode = 'voice' | 'video' | null;

interface RecordButtonProps {
  onRecorded: (file: File) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}

const DROPDOWN_HEIGHT = 114;
const DROPDOWN_MIN_WIDTH = 168;
const DROPDOWN_SIDE_GAP = 8;

function getExtension(mode: Exclude<RecordMode, null>, mimeType: string): string {
  if (mode === 'video') return mimeType.includes('mp4') ? 'mp4' : 'webm';
  return mimeType.includes('mp4') || mimeType.includes('aac') ? 'm4a' : 'webm';
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function RecordButton({ onRecorded, onError, disabled = false }: RecordButtonProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const [mode, setMode] = useState<RecordMode>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  const [photoActive, setPhotoActive] = useState(false);
  const photoVideoRef = useRef<HTMLVideoElement | null>(null);
  const photoStreamRef = useRef<MediaStream | null>(null);

  const { recording, duration, start, stop, cancel } = useMediaRecorder(onError);

  useEffect(() => {
    const handleClickOutside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (dropdownRef.current?.contains(target) || buttonRef.current?.contains(target)) {
        return;
      }
      setShowDropdown(false);
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, []);

  const toggleDropdown = useCallback(() => {
    if (recording || photoActive || disabled) return;
    if (showDropdown) {
      setShowDropdown(false);
      return;
    }
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const openUp = isMobile || (spaceBelow < DROPDOWN_HEIGHT && rect.top >= DROPDOWN_HEIGHT);
      const maxLeft = Math.max(DROPDOWN_SIDE_GAP, window.innerWidth - DROPDOWN_MIN_WIDTH - DROPDOWN_SIDE_GAP);
      setDropdownPos({
        top: openUp ? Math.max(DROPDOWN_SIDE_GAP, rect.top - DROPDOWN_HEIGHT - 4) : rect.bottom + 4,
        left: Math.min(Math.max(rect.left, DROPDOWN_SIDE_GAP), maxLeft),
      });
    }
    setShowDropdown(true);
  }, [recording, photoActive, disabled, showDropdown, isMobile]);

  const handleSelect = useCallback(
    async (selected: 'voice' | 'video') => {
      setShowDropdown(false);
      const started = await start(selected === 'video');
      if (started) setMode(selected);
    },
    [start],
  );

  const handleStop = useCallback(async () => {
    if (!mode) return;
    const blob = await stop();
    if (!blob || blob.size === 0) return;
    const ext = getExtension(mode, blob.type);
    const name = `${mode === 'video' ? 'video-note' : 'voice-note'}-${Date.now()}.${ext}`;
    const type = blob.type || (mode === 'video' ? 'video/webm' : 'audio/webm');
    const file = new File([blob], name, { type });
    setMode(null);
    onRecorded(file);
  }, [stop, mode, onRecorded]);

  const handleCancel = useCallback(() => {
    cancel();
    setMode(null);
  }, [cancel]);

  const stopPhotoStream = useCallback(() => {
    photoStreamRef.current?.getTracks().forEach((track) => track.stop());
    photoStreamRef.current = null;
    if (photoVideoRef.current) photoVideoRef.current.srcObject = null;
  }, []);

  useEffect(() => () => stopPhotoStream(), [stopPhotoStream]);

  const setPhotoVideoRef = useCallback((el: HTMLVideoElement | null) => {
    photoVideoRef.current = el;
    if (el && photoStreamRef.current) {
      el.srcObject = photoStreamRef.current;
      el.play().catch(() => {});
    }
  }, []);

  const startPhoto = useCallback(async () => {
    setShowDropdown(false);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      onError?.('Camera capture is not supported in this browser');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      photoStreamRef.current = stream;
      setPhotoActive(true);
    } catch {
      onError?.('Camera access was denied');
    }
  }, [onError]);

  const handleCapture = useCallback(() => {
    const video = photoVideoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
      stopPhotoStream();
      setPhotoActive(false);
      onRecorded(file);
    }, 'image/jpeg', 0.92);
  }, [onRecorded, stopPhotoStream]);

  const handlePhotoCancel = useCallback(() => {
    stopPhotoStream();
    setPhotoActive(false);
  }, [stopPhotoStream]);

  return (
    <div className={styles.container}>
      {recording ? (
        <div className={styles.recordingPill}>
          <span className={styles.recDot} />
          <span className={styles.recTimer}>{formatDuration(duration)}</span>
          <button
            type="button"
            className={styles.stopButton}
            onClick={handleStop}
            title="Stop and attach recording"
            aria-label="Stop and attach recording"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={handleCancel}
            title="Discard recording"
            aria-label="Discard recording"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ) : (
        <>
          <button
            ref={buttonRef}
            type="button"
            className={styles.recordButton}
            onClick={toggleDropdown}
            disabled={disabled}
            aria-label="Record voice, video note, or take photo"
            title="Record voice, video note, or take photo"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={styles.chevron}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {showDropdown && (
            <Portal>
              <div
                ref={dropdownRef}
                className={styles.dropdown}
                style={dropdownPos ? { top: dropdownPos.top, left: dropdownPos.left } : undefined}
                role="menu"
              >
                <button type="button" className={styles.dropdownItem} role="menuitem" onClick={() => handleSelect('voice')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                  <span>Voice Note</span>
                </button>
                <button type="button" className={styles.dropdownItem} role="menuitem" onClick={() => handleSelect('video')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="23 7 16 12 23 17 23 7" />
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                  </svg>
                  <span>Video Note</span>
                </button>
                <button type="button" className={styles.dropdownItem} role="menuitem" onClick={startPhoto}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  <span>Take Photo</span>
                </button>
              </div>
            </Portal>
          )}
        </>
      )}

      {photoActive && (
        <Portal>
          <div className={styles.photoOverlay} role="dialog" aria-modal="true" aria-label="Take photo">
            <div className={styles.photoCard}>
              <video ref={setPhotoVideoRef} className={styles.photoVideo} autoPlay playsInline muted />
              <div className={styles.photoControls}>
                <button
                  type="button"
                  className={styles.photoCapture}
                  onClick={handleCapture}
                  title="Capture photo"
                  aria-label="Capture photo"
                >
                  <span className={styles.photoCaptureRing} />
                </button>
                <button
                  type="button"
                  className={styles.photoCancel}
                  onClick={handlePhotoCancel}
                  title="Cancel"
                  aria-label="Cancel"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </div>
  );
}
