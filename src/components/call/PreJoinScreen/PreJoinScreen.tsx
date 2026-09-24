import { useEffect, useRef, useState, useCallback } from 'react';
import { useCallContext } from '@/app/providers/CallProvider/CallProvider';
import styles from './PreJoinScreen.module.css';

export function PreJoinScreen() {
  const { acceptCall, currentCall } = useCallContext();
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [devices, setDevices] = useState<{ audioInputs: { deviceId: string; label: string }[]; videoInputs: { deviceId: string; label: string }[] }>({ audioInputs: [], videoInputs: [] });
  const [selectedMic, setSelectedMic] = useState<string>('');
  const [selectedCamera, setSelectedCamera] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        previewStreamRef.current = stream;
        setPreviewStream(stream);
        if (videoRef.current) videoRef.current.srcObject = stream;

        const devs = await navigator.mediaDevices.enumerateDevices();
        setDevices({
          audioInputs: devs.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label || `Mic ${d.deviceId.slice(0, 4)}` })),
          videoInputs: devs.filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, label: d.label || `Camera ${d.deviceId.slice(0, 4)}` })),
        });
      } catch { /* camera/mic denied */ }
    };
    start();

    return () => {
      cancelled = true;
      previewStreamRef.current?.getTracks().forEach((t) => t.stop());
      previewStreamRef.current = null;
    };
  }, []);

  const toggleCamera = () => {
    if (previewStream) {
      const videoTrack = previewStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setCameraEnabled(videoTrack.enabled);
      }
    }
  };

  const toggleMic = () => {
    if (previewStream) {
      const audioTrack = previewStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setMicEnabled(audioTrack.enabled);
      }
    }
  };

  const handleJoin = async (withVideo: boolean) => {
    previewStream?.getTracks().forEach((t) => t.stop());
    await acceptCall(withVideo);
  };

  return (
    <div className={styles.container}>
      <div className={styles.preview}>
        {cameraEnabled ? (
          <video ref={videoRef} autoPlay playsInline muted className={styles.video} />
        ) : (
          <div className={styles.videoOff}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M23 7l-7 5 7 5V7z" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
            <span>Camera is off</span>
          </div>
        )}
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={`${styles.controlButton} ${!micEnabled ? styles.controlButtonOff : ''}`}
          onClick={toggleMic}
          aria-label={micEnabled ? 'Mute microphone' : 'Unmute microphone'}
        >
          {micEnabled ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className={`${styles.controlButton} ${!cameraEnabled ? styles.controlButtonOff : ''}`}
          onClick={toggleCamera}
          aria-label={cameraEnabled ? 'Turn off camera' : 'Turn on camera'}
        >
          {cameraEnabled ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 7l-7 5 7 5V7z" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          )}
        </button>
      </div>

      {devices.videoInputs.length > 1 && (
        <select
          className={styles.deviceSelect}
          value={selectedCamera}
          onChange={(e) => setSelectedCamera(e.target.value)}
        >
          {devices.videoInputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))}
        </select>
      )}

      {devices.audioInputs.length > 1 && (
        <select
          className={styles.deviceSelect}
          value={selectedMic}
          onChange={(e) => setSelectedMic(e.target.value)}
        >
          {devices.audioInputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))}
        </select>
      )}

      <div className={styles.joinActions}>
        <button type="button" className={`${styles.joinButton} ${styles.joinVideo}`} onClick={() => handleJoin(true)}>
          Join with Video
        </button>
        <button type="button" className={styles.joinButton} onClick={() => handleJoin(false)}>
          Join without Video
        </button>
      </div>
    </div>
  );
}
