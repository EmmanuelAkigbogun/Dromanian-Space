import { useCallback, useRef } from 'react';
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';

interface LegacyPeerEntry {
  peerConnection: RTCPeerConnection;
  remoteStream: MediaStream;
  remoteAudioElement: HTMLAudioElement | null;
  userId: string;
}

interface MediaTokenResponse {
  token: string;
  url: string;
  room: string;
}

/**
 * Self-hosted LiveKit call transport.
 *
 * The public shape intentionally matches the old peer-to-peer engine so the
 * call UI and database-backed call lifecycle remain compatible. LiveKit owns
 * WebRTC negotiation, reconnects, SFU routing and TURN fallback; the app only
 * publishes local media and renders subscribed tracks.
 */
export function useCallEngine() {
  const roomRef = useRef<Room | null>(null);
  const connectRef = useRef<Promise<void> | null>(null);
  const callIdRef = useRef<string | null>(null);
  const myUserIdRef = useRef('');
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const remoteAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const publishedTrackIdsRef = useRef<Set<string>>(new Set());
  const legacyPeersRef = useRef<Map<string, LegacyPeerEntry>>(new Map());
  const manualDisconnectRef = useRef(false);

  const onRemoteStreamRef = useRef<((userId: string, stream: MediaStream) => void) | null>(null);
  const onCallEndRef = useRef<(() => void) | null>(null);
  const onPeerConnectedRef = useRef<((userId: string) => void) | null>(null);
  const onAudioPlaybackBlockedRef = useRef<((blocked: boolean) => void) | null>(null);

  const notifyRemoteStream = useCallback((userId: string) => {
    const stream = remoteStreamsRef.current.get(userId);
    if (stream) onRemoteStreamRef.current?.(userId, stream);
  }, []);

  const getRemoteStream = useCallback((userId: string) => {
    let stream = remoteStreamsRef.current.get(userId);
    if (!stream) {
      stream = new MediaStream();
      remoteStreamsRef.current.set(userId, stream);
    }
    return stream;
  }, []);

  const removeRemoteParticipant = useCallback((userId: string) => {
    const element = remoteAudioElementsRef.current.get(userId);
    if (element) {
      try { element.pause(); } catch { /* already stopped */ }
      element.remove();
      remoteAudioElementsRef.current.delete(userId);
    }
    remoteStreamsRef.current.delete(userId);
  }, []);

  const playRemoteAudio = useCallback(async (userId: string, track?: RemoteTrack) => {
    let element = remoteAudioElementsRef.current.get(userId);
    if (!element) {
      element = document.createElement('audio');
      element.autoplay = true;
      element.controls = false;
      element.muted = false;
      element.volume = 1;
      element.setAttribute('playsinline', '');
      element.dataset.callParticipant = userId;
      element.style.display = 'none';
      document.body.appendChild(element);
      remoteAudioElementsRef.current.set(userId, element);
    }

    if (track) track.attach(element);
    try {
      element.muted = false;
      element.volume = 1;
      await element.play();
      onAudioPlaybackBlockedRef.current?.(false);
      return true;
    } catch (error) {
      console.warn('[call] browser blocked remote audio; user interaction is required', error);
      onAudioPlaybackBlockedRef.current?.(true);
      return false;
    }
  }, []);

  const publishLocalTracks = useCallback(async (room: Room) => {
    const stream = localStreamRef.current;
    if (!stream) return;

    for (const mediaTrack of stream.getTracks()) {
      if (publishedTrackIdsRef.current.has(mediaTrack.id)) continue;
      await room.localParticipant.publishTrack(mediaTrack, {
        source: mediaTrack.kind === 'audio' ? Track.Source.Microphone : Track.Source.Camera,
      });
      publishedTrackIdsRef.current.add(mediaTrack.id);
    }
  }, []);

  const attachRoomEvents = useCallback((room: Room) => {
    room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      onPeerConnectedRef.current?.(participant.identity);
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      removeRemoteParticipant(participant.identity);
    });

    room.on(RoomEvent.TrackSubscribed, (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      const stream = getRemoteStream(participant.identity);
      const mediaTrack = track.mediaStreamTrack;
      if (!stream.getTracks().some((candidate) => candidate.id === mediaTrack.id)) {
        stream.addTrack(mediaTrack);
      }
      notifyRemoteStream(participant.identity);
      onPeerConnectedRef.current?.(participant.identity);
      if (track.kind === Track.Kind.Audio) void playRemoteAudio(participant.identity, track);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _publication, participant: RemoteParticipant) => {
      const stream = remoteStreamsRef.current.get(participant.identity);
      const mediaTrack = track.mediaStreamTrack;
      if (stream?.getTracks().some((candidate) => candidate.id === mediaTrack.id)) {
        stream.removeTrack(mediaTrack);
        notifyRemoteStream(participant.identity);
      }
      track.detach().forEach((element) => element.remove());
    });

    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      onAudioPlaybackBlockedRef.current?.(!room.canPlaybackAudio);
    });

    room.on(RoomEvent.Disconnected, () => {
      if (!manualDisconnectRef.current) onCallEndRef.current?.();
    });
  }, [getRemoteStream, notifyRemoteStream, playRemoteAudio, removeRemoteParticipant]);

  const ensureConnected = useCallback(async () => {
    if (roomRef.current?.state === ConnectionState.Connected) {
      await publishLocalTracks(roomRef.current);
      return;
    }
    if (connectRef.current) return connectRef.current;

    const callId = callIdRef.current;
    if (!callId) throw new Error('Cannot connect call media before signaling is initialized');

    const connection = (async () => {
      const response = await fetch(`/api/calls/${callId}/media-token`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `Call media authorization failed (${response.status})`);
      }
      const credentials = await response.json() as MediaTokenResponse;

      manualDisconnectRef.current = false;
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        disconnectOnPageLeave: true,
        stopLocalTrackOnUnpublish: false,
      });
      attachRoomEvents(room);
      roomRef.current = room;
      await room.connect(credentials.url, credentials.token, { autoSubscribe: true });
      await publishLocalTracks(room);
      for (const participant of room.remoteParticipants.values()) {
        onPeerConnectedRef.current?.(participant.identity);
      }
    })();

    connectRef.current = connection;
    try {
      await connection;
    } finally {
      if (connectRef.current === connection) connectRef.current = null;
    }
  }, [attachRoomEvents, publishLocalTracks]);

  const startLocalMedia = useCallback(async (withVideo: boolean): Promise<MediaStream | null> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
      });
      localStreamRef.current = stream;
      return stream;
    } catch (primaryError) {
      if (withVideo) {
        try {
          const audioOnly = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          });
          localStreamRef.current = audioOnly;
          return audioOnly;
        } catch (audioError) {
          console.error('[call] camera and microphone access failed', primaryError, audioError);
        }
      } else {
        console.error('[call] microphone access failed', primaryError);
      }
      return null;
    }
  }, []);

  const stopLocalMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    publishedTrackIdsRef.current.clear();
  }, []);

  const setupSignaling = useCallback((callId: string, myUserId: string) => {
    callIdRef.current = callId;
    myUserIdRef.current = myUserId;
    manualDisconnectRef.current = false;
  }, []);

  const createOffer = useCallback(async (_remoteUserId: string, _localStream: MediaStream) => {
    await ensureConnected();
  }, [ensureConnected]);

  const processPendingOffers = useCallback(async () => {
    await ensureConnected();
  }, [ensureConnected]);

  const startOfferRetry = useCallback(() => {
    // LiveKit handles reconnects and renegotiation internally.
  }, []);

  const stopOfferRetry = useCallback(() => {
    // LiveKit handles reconnects and renegotiation internally.
  }, []);

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    const publication = roomRef.current?.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (track.enabled) void publication?.unmute();
    else void publication?.mute();
    return !track.enabled;
  }, []);

  const toggleVideo = useCallback(() => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    const publication = roomRef.current?.localParticipant.getTrackPublication(Track.Source.Camera);
    if (track.enabled) void publication?.unmute();
    else void publication?.mute();
    return track.enabled;
  }, []);

  const enableVideo = useCallback(async () => {
    const existing = localStreamRef.current?.getVideoTracks()[0];
    if (existing) {
      existing.enabled = true;
      await roomRef.current?.localParticipant.getTrackPublication(Track.Source.Camera)?.unmute();
      return true;
    }
    try {
      const camera = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      });
      const track = camera.getVideoTracks()[0];
      if (!track) return false;
      if (!localStreamRef.current) localStreamRef.current = new MediaStream();
      localStreamRef.current.addTrack(track);
      if (roomRef.current?.state === ConnectionState.Connected) await publishLocalTracks(roomRef.current);
      return true;
    } catch {
      return false;
    }
  }, [publishLocalTracks]);

  const startScreenShare = useCallback(async (): Promise<MediaStream | null> => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0];
      if (!track || !roomRef.current) return null;
      screenStreamRef.current = stream;
      await roomRef.current.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare });
      track.onended = () => {
        if (screenStreamRef.current === stream) {
          void roomRef.current?.localParticipant.unpublishTrack(track, true);
          screenStreamRef.current = null;
        }
      };
      return stream;
    } catch {
      return null;
    }
  }, []);

  const stopScreenShare = useCallback(() => {
    const stream = screenStreamRef.current;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      void roomRef.current?.localParticipant.unpublishTrack(track, true);
      track.stop();
    }
    screenStreamRef.current = null;
  }, []);

  const cleanupPeer = useCallback((userId: string) => {
    removeRemoteParticipant(userId);
  }, [removeRemoteParticipant]);

  const cleanupAll = useCallback(() => {
    manualDisconnectRef.current = true;
    stopScreenShare();
    const room = roomRef.current;
    roomRef.current = null;
    connectRef.current = null;
    if (room) void room.disconnect(true);
    for (const userId of remoteStreamsRef.current.keys()) removeRemoteParticipant(userId);
    remoteStreamsRef.current.clear();
    legacyPeersRef.current.clear();
    stopLocalMedia();
    callIdRef.current = null;
    myUserIdRef.current = '';
    onAudioPlaybackBlockedRef.current?.(false);
  }, [removeRemoteParticipant, stopLocalMedia, stopScreenShare]);

  const broadcastMute = useCallback((isMuted: boolean) => {
    const callId = callIdRef.current;
    if (!callId) return;
    void import('@/lib/call/call').then(({ updateCallParticipantMuted }) =>
      updateCallParticipantMuted(callId, isMuted),
    );
  }, []);

  const broadcastEndCall = useCallback(async () => {
    // The validated call endpoint updates the shared call state. LiveKit room
    // disconnects are handled by cleanupAll after that update succeeds.
  }, []);

  const getDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      audioInputs: devices.filter((device) => device.kind === 'audioinput'),
      videoInputs: devices.filter((device) => device.kind === 'videoinput'),
      audioOutputs: devices.filter((device) => device.kind === 'audiooutput'),
    };
  }, []);

  const switchDevice = useCallback(async (kind: 'audioinput' | 'videoinput', deviceId: string) => {
    const constraints: MediaStreamConstraints = kind === 'audioinput'
      ? { audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true } }
      : { video: { deviceId: { exact: deviceId } } };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const nextTrack = stream.getTracks()[0];
    if (!nextTrack) return;
    const currentStream = localStreamRef.current ?? new MediaStream();
    localStreamRef.current = currentStream;
    const previous = nextTrack.kind === 'audio' ? currentStream.getAudioTracks()[0] : currentStream.getVideoTracks()[0];
    if (previous) {
      await roomRef.current?.localParticipant.unpublishTrack(previous, false);
      currentStream.removeTrack(previous);
      publishedTrackIdsRef.current.delete(previous.id);
      previous.stop();
    }
    currentStream.addTrack(nextTrack);
    if (roomRef.current?.state === ConnectionState.Connected) await publishLocalTracks(roomRef.current);
  }, [publishLocalTracks]);

  const resumeAllAudio = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return true;
    try {
      await room.startAudio();
      const results = await Promise.all(
        Array.from(remoteAudioElementsRef.current.entries()).map(([userId]) => playRemoteAudio(userId)),
      );
      const playing = room.canPlaybackAudio && results.every(Boolean);
      onAudioPlaybackBlockedRef.current?.(!playing);
      return playing;
    } catch {
      onAudioPlaybackBlockedRef.current?.(true);
      return false;
    }
  }, [playRemoteAudio]);

  return {
    startLocalMedia,
    stopLocalMedia,
    createOffer,
    setupSignaling,
    processPendingOffers,
    startOfferRetry,
    stopOfferRetry,
    toggleMute,
    toggleVideo,
    enableVideo,
    startScreenShare,
    stopScreenShare,
    getDevices,
    switchDevice,
    broadcastMute,
    broadcastEndCall,
    cleanupAll,
    cleanupPeer,
    onRemoteStream: (callback: (userId: string, stream: MediaStream) => void) => {
      onRemoteStreamRef.current = callback;
    },
    onCallEnd: (callback: () => void) => {
      onCallEndRef.current = callback;
    },
    onPeerConnected: (callback: (userId: string) => void) => {
      onPeerConnectedRef.current = callback;
    },
    onAudioPlaybackBlocked: (callback: (blocked: boolean) => void) => {
      onAudioPlaybackBlockedRef.current = callback;
    },
    getPeers: () => legacyPeersRef.current,
    getLocalStream: () => localStreamRef.current,
    getScreenStream: () => screenStreamRef.current,
    resumeAllAudio,
  };
}
