import { useRef, useCallback } from 'react';
import { platform } from '@/lib/platform';

// If `call_signaling` isn't in the generated database types yet (e.g. the
// types file wasn't regenerated after migration 016_call_signaling.sql),
// the client's generic inference can collapse to `never` for this table and
// TypeScript will flag properties in the insert object below even though
// they're correct. Casting to `any` here matches the same workaround already
// used in call.ts (`const db = platform as any;`). The real, permanent fix is
// to regenerate your types: `platform gen types typescript --project-id <id> > src/types/database.types.ts`
// (or your project's equivalent command) so `call_signaling` is recognized -
// do that when you get a chance and you can remove this cast.
const FALLBACK_ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

interface PeerEntry {
  peerConnection: RTCPeerConnection;
  remoteStream: MediaStream;
  remoteAudioElement: HTMLAudioElement | null;
  userId: string;
  // FIX: tracks whether the *initial* offer/answer exchange has completed for
  // this peer. Adding tracks during createPeerConnection's initial setup fires
  // `onnegotiationneeded` once before the manual createOffer/handleOffer flow
  // runs; without this flag that fires a duplicate, premature renegotiation.
  negotiationReady: boolean;
}

export function useCallEngine() {
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const signalingChannelRef = useRef<any>(null);
  const callIdRef = useRef<string | null>(null);
  const myUserIdRef = useRef<string>('');
  const onRemoteStreamRef = useRef<((userId: string, stream: MediaStream) => void) | null>(null);
  const onCallEndRef = useRef<(() => void) | null>(null);
  const onPeerConnectedRef = useRef<((userId: string) => void) | null>(null);
  const onAudioPlaybackBlockedRef = useRef<((blocked: boolean) => void) | null>(null);
  const blockedAudioPeersRef = useRef<Set<string>>(new Set());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const remoteAudioContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingOffersRef = useRef<Array<{ fromUserId: string; offer: RTCSessionDescriptionInit }>>([]);
  const pendingOffersForRetryRef = useRef<Map<string, RTCSessionDescriptionInit>>(new Map());
  const offerRetryIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const destroyedRef = useRef<boolean>(false);
  const processedMsgIdsRef = useRef<Set<string>>(new Set());
  const iceConfigurationRef = useRef<RTCConfiguration>(FALLBACK_ICE_SERVERS);

  const getRemoteAudioContainer = useCallback(() => {
    if (!remoteAudioContainerRef.current) {
      const div = document.createElement('div');
      div.style.position = 'fixed';
      div.style.bottom = '0';
      div.style.left = '0';
      div.style.width = '1px';
      div.style.height = '1px';
      div.style.opacity = '0.01';
      div.style.pointerEvents = 'none';
      div.style.zIndex = '-1';
      document.body.appendChild(div);
      remoteAudioContainerRef.current = div;
    }
    return remoteAudioContainerRef.current;
  }, []);

  const startLocalMedia = useCallback(
    async (withVideo: boolean): Promise<MediaStream | null> => {
      try {
        try {
          const response = await fetch('/api/calls/ice', { credentials: 'same-origin' });
          if (response.ok) iceConfigurationRef.current = { iceServers: (await response.json()).iceServers };
          else console.warn('[call] TURN relay unavailable; calls may fail across different networks');
        } catch { console.warn('[call] Could not load TURN credentials'); }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: withVideo ? { width: 640, height: 480, facingMode: 'user' } : false,
        });
        localStreamRef.current = stream;
        return stream;
      } catch (err) {
        console.warn('[call] primary getUserMedia failed:', err);
        if (withVideo) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            localStreamRef.current = stream;
            return stream;
          } catch (err2) {
            console.error('[call] audio-only getUserMedia also failed:', err2);
          }
        } else {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
            localStreamRef.current = stream;
            return stream;
          } catch (err2) {
            console.error('[call] minimal audio getUserMedia also failed:', err2);
          }
        }
        return null;
      }
    },
    [],
  );

  const stopLocalMedia = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
  }, []);

  const sendSignaling = useCallback(async (
    type: string,
    toUserId: string,
    payload: Record<string, unknown>,
  ) => {
    // FIX: snapshot the ref into a local const so TypeScript narrows it from
    // `string | null` to `string` for the rest of this scope. Reading
    // `callIdRef.current` directly (even after the guard above) still types
    // as `string | null` because TS can't guarantee a mutable ref's `.current`
    // wasn't reassigned between the check and the read - especially across
    // an `await`. A local const doesn't have that problem.
    const callId = callIdRef.current;
    if (destroyedRef.current || !callId) return;
    try {
      const response = await fetch(`/api/calls/${callId}/signals`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toUserId, type, payload, clientMessageId: crypto.randomUUID() }),
      });
      if (!response.ok) console.warn('[call] signaling API rejected a message');
    } catch (err) {
      console.error('[call] sendSignaling failed:', err);
    }
  }, []);

  const playRemoteAudio = useCallback(async (userId: string, element: HTMLAudioElement): Promise<boolean> => {
    try {
      element.muted = false;
      element.volume = 1;
      await element.play();
      blockedAudioPeersRef.current.delete(userId);
      onAudioPlaybackBlockedRef.current?.(blockedAudioPeersRef.current.size > 0);
      return true;
    } catch (error) {
      blockedAudioPeersRef.current.add(userId);
      onAudioPlaybackBlockedRef.current?.(true);
      console.warn('[call] remote audio playback was blocked by the browser:', error);
      return false;
    }
  }, []);

  const cleanupPeer = useCallback((userId: string) => {
    const entry = peersRef.current.get(userId);
    if (entry) {
      try { entry.remoteAudioElement?.pause(); } catch { }
      try { entry.remoteAudioElement?.remove(); } catch { }
      try { entry.peerConnection.close(); } catch { }
      peersRef.current.delete(userId);
    }
    blockedAudioPeersRef.current.delete(userId);
    onAudioPlaybackBlockedRef.current?.(blockedAudioPeersRef.current.size > 0);
  }, []);

  const cleanupAll = useCallback(() => {
    destroyedRef.current = true;
    peersRef.current.forEach((entry) => {
      try { entry.remoteAudioElement?.pause(); } catch { }
      try { entry.remoteAudioElement?.remove(); } catch { }
      try { entry.peerConnection.close(); } catch { }
    });
    peersRef.current.clear();
    blockedAudioPeersRef.current.clear();
    onAudioPlaybackBlockedRef.current?.(false);
    pendingIceRef.current.clear();
    stopLocalMedia();
    if (signalingChannelRef.current) {
      const ch = signalingChannelRef.current;
      signalingChannelRef.current = null;
      try { platform.removeChannel(ch); } catch { }
    }
    callIdRef.current = null;
    pendingOffersRef.current = [];
    pendingOffersForRetryRef.current.clear();
    if (offerRetryIntervalRef.current) {
      clearInterval(offerRetryIntervalRef.current);
      offerRetryIntervalRef.current = null;
    }
    processedMsgIdsRef.current.clear();
  }, [stopLocalMedia]);

  // FIX: creates a fresh offer on an *existing* peer connection instead of
  // tearing it down. Used both for the automatic onnegotiationneeded hook
  // (e.g. enabling video mid-call) and could be called manually later.
  const renegotiate = useCallback(
    async (remoteUserId: string) => {
      const entry = peersRef.current.get(remoteUserId);
      if (!entry) return;
      try {
        const offer = await entry.peerConnection.createOffer();
        await entry.peerConnection.setLocalDescription(offer);
        const offerData = entry.peerConnection.localDescription?.toJSON();
        if (offerData) {
          await sendSignaling('offer', remoteUserId, { offer: offerData, renegotiate: true });
        }
      } catch (err) {
        console.error(`[call] renegotiate with ${remoteUserId} failed:`, err);
      }
    },
    [sendSignaling],
  );

  const createPeerConnection = useCallback(
    (remoteUserId: string, localStream: MediaStream): PeerEntry => {
      const pc = new RTCPeerConnection(iceConfigurationRef.current);
      const remoteStream = new MediaStream();

      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });

      pc.ontrack = (event) => {
        const track = event.track;
        if (track && !remoteStream.getTracks().some((t) => t.id === track.id)) {
          remoteStream.addTrack(track);
        }
        for (const stream of event.streams) {
          stream.getTracks().forEach((t) => {
            if (!remoteStream.getTracks().some((rt) => rt.id === t.id)) {
              remoteStream.addTrack(t);
            }
          });
        }
        onRemoteStreamRef.current?.(remoteUserId, remoteStream);
        const el = document.getElementById(`call-audio-${remoteUserId}`) as HTMLAudioElement | null;
        if (el && el.srcObject !== remoteStream) {
          el.srcObject = remoteStream;
        }
        if (el && remoteStream.getAudioTracks().length > 0) {
          void playRemoteAudio(remoteUserId, el);
        }
        if (track.kind === 'audio') {
          track.onunmute = () => { void playRemoteAudio(remoteUserId, audioEl); };
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignaling('ice-candidate', remoteUserId, {
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          onPeerConnectedRef.current?.(remoteUserId);
          const buffered = pendingIceRef.current.get(remoteUserId);
          if (buffered) {
            for (const c of buffered) {
              pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => { });
            }
            pendingIceRef.current.delete(remoteUserId);
          }
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          cleanupPeer(remoteUserId);
        }
      };

      // FIX: renegotiation support. Fires when a track is added/removed after
      // the initial offer/answer exchange (e.g. enabling video mid-call, or
      // adding a screen-share track that isn't a simple replaceTrack). Guarded
      // by `negotiationReady` so it doesn't fire during the initial handshake
      // that createOffer/handleOffer already handle explicitly.
      pc.onnegotiationneeded = () => {
        const entry = peersRef.current.get(remoteUserId);
        if (!entry || !entry.negotiationReady) return;
        if (pc.signalingState !== 'stable') return;
        renegotiate(remoteUserId).catch(() => { });
      };

      const container = getRemoteAudioContainer();
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.muted = false;
      audioEl.volume = 1;
      audioEl.preload = 'auto';
      audioEl.setAttribute('playsinline', '');
      audioEl.id = `call-audio-${remoteUserId}`;
      audioEl.srcObject = remoteStream;
      audioEl.oncanplay = () => { void playRemoteAudio(remoteUserId, audioEl); };
      audioEl.onplaying = () => {
        blockedAudioPeersRef.current.delete(remoteUserId);
        onAudioPlaybackBlockedRef.current?.(blockedAudioPeersRef.current.size > 0);
      };
      container.appendChild(audioEl);

      const entry: PeerEntry = {
        peerConnection: pc,
        remoteStream,
        remoteAudioElement: audioEl,
        userId: remoteUserId,
        negotiationReady: false,
      };

      peersRef.current.set(remoteUserId, entry);
      return entry;
    },
    [getRemoteAudioContainer, sendSignaling, cleanupPeer, renegotiate, playRemoteAudio],
  );

  const handleOffer = useCallback(
    async (fromUserId: string, offer: RTCSessionDescriptionInit, localStream: MediaStream) => {
      try {
        if (peersRef.current.has(fromUserId)) {
          cleanupPeer(fromUserId);
        }
        const entry = createPeerConnection(fromUserId, localStream);
        await entry.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await entry.peerConnection.createAnswer();
        await entry.peerConnection.setLocalDescription(answer);

        await sendSignaling('answer', fromUserId, {
          answer: entry.peerConnection.localDescription?.toJSON(),
        });
        entry.negotiationReady = true;
      } catch (err) {
        console.error('[call] handleOffer failed:', err);
      }
    },
    [createPeerConnection, sendSignaling, cleanupPeer],
  );

  // FIX: handles a renegotiation offer on an EXISTING connected peer, without
  // tearing anything down. This is what actually lets the remote side pick up
  // a video track added mid-call.
  const handleRenegotiationOffer = useCallback(
    async (fromUserId: string, offer: RTCSessionDescriptionInit) => {
      const entry = peersRef.current.get(fromUserId);
      if (!entry) return;
      try {
        await entry.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await entry.peerConnection.createAnswer();
        await entry.peerConnection.setLocalDescription(answer);
        await sendSignaling('answer', fromUserId, {
          answer: entry.peerConnection.localDescription?.toJSON(),
        });
      } catch (err) {
        console.error('[call] handleRenegotiationOffer failed:', err);
      }
    },
    [sendSignaling],
  );

  const handleAnswer = useCallback(
    async (fromUserId: string, answer: RTCSessionDescriptionInit) => {
      try {
        const entry = peersRef.current.get(fromUserId);
        if (!entry) return;
        if (entry.peerConnection.signalingState !== 'have-local-offer') {
          pendingOffersForRetryRef.current.delete(fromUserId);
          return;
        }
        try {
          await entry.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
          if (entry.peerConnection.signalingState !== 'have-local-offer') {
            pendingOffersForRetryRef.current.delete(fromUserId);
            return;
          }
          throw err;
        }
        entry.negotiationReady = true;
        pendingOffersForRetryRef.current.delete(fromUserId);
        const buffered = pendingIceRef.current.get(fromUserId);
        if (buffered) {
          for (const c of buffered) {
            await entry.peerConnection.addIceCandidate(new RTCIceCandidate(c)).catch(() => { });
          }
          pendingIceRef.current.delete(fromUserId);
        }
      } catch (err) {
        console.error('[call] handleAnswer failed:', err);
      }
    },
    [],
  );

  const handleIceCandidate = useCallback(
    async (fromUserId: string, candidate: RTCIceCandidateInit) => {
      try {
        const entry = peersRef.current.get(fromUserId);
        if (entry) {
          await entry.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          if (!pendingIceRef.current.has(fromUserId)) pendingIceRef.current.set(fromUserId, []);
          pendingIceRef.current.get(fromUserId)!.push(candidate);
        }
      } catch { /* ice candidate errors are non-fatal */ }
    },
    [],
  );

  const setupSignaling = useCallback(
    (callId: string, myUserId: string) => {
      destroyedRef.current = false;
      callIdRef.current = callId;
      myUserIdRef.current = myUserId;
      processedMsgIdsRef.current.clear();

      if (signalingChannelRef.current) {
        const old = signalingChannelRef.current;
        signalingChannelRef.current = null;
        try { platform.removeChannel(old); } catch { }
      }

      const ch = platform.channel(`call-signal:${callId}:${myUserId}`);

      ch.on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'call_signaling',
        filter: `to_user_id=eq.${myUserId}`,
      }, async (payload) => {
        try {
          const msg = payload.new as { id: string; type: string; from_user_id: string; payload: any };
          if (processedMsgIdsRef.current.has(msg.id)) return;
          processedMsgIdsRef.current.add(msg.id);

          if (msg.type === 'offer') {
            const isRenegotiation = !!msg.payload?.renegotiate;
            const existingPeer = peersRef.current.get(msg.from_user_id);

            if (existingPeer) {
              const cs = existingPeer.peerConnection.connectionState;

              if (isRenegotiation) {
                // A genuine renegotiation offer (e.g. remote enabled video).
                // Always apply it to the existing connection - never tear down.
                await handleRenegotiationOffer(msg.from_user_id, msg.payload.offer);
                return;
              }

              if (cs === 'failed' || cs === 'closed') {
                // Connection is actually dead - safe to rebuild.
                cleanupPeer(msg.from_user_id);
              } else {
                // FIX: this used to tear down and recreate the peer for ANY
                // non-connected/connecting state (including 'new', which is
                // normal while ICE is still gathering). Combined with the 3s
                // offer-retry loop, a slow ICE handshake meant every retry
                // reset negotiation back to zero, so the call could hang
                // forever and never reach 'active'. A retried/duplicate
                // initial offer while we're still negotiating (or already
                // connected) should just be ignored.
                return;
              }
            }

            if (localStreamRef.current) {
              await handleOffer(msg.from_user_id, msg.payload.offer, localStreamRef.current);
            } else {
              pendingOffersRef.current = pendingOffersRef.current.filter((o) => o.fromUserId !== msg.from_user_id);
              pendingOffersRef.current.push({ fromUserId: msg.from_user_id, offer: msg.payload.offer });
            }
          } else if (msg.type === 'answer') {
            await handleAnswer(msg.from_user_id, msg.payload.answer);
          } else if (msg.type === 'ice-candidate') {
            await handleIceCandidate(msg.from_user_id, msg.payload.candidate);
          } else if (msg.type === 'end-call') {
            onCallEndRef.current?.();
          }
        } catch (err) {
          console.error('[call] signaling handler error:', err);
        }
      });

      signalingChannelRef.current = ch;

      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[call] signaling channel subscribed (db-backed)');
          fetch(`/api/calls/${callId}/signals`, { credentials: 'same-origin' })
            .then((response) => response.ok ? response.json() : [])
            .then((messages) => Promise.all((messages as any[]).map((message) => {
              ch.dispatch({ kind: 'postgres_changes', table: 'call_signaling', event: 'INSERT', payload: { new: message, old: {}, eventType: 'INSERT' } });
            })))
            .catch(() => undefined);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(`[call] signaling channel failed: ${status}, retrying...`);
          if (!destroyedRef.current && signalingChannelRef.current === ch) {
            try { ch.subscribe(); } catch { }
          }
        }
      });
    },
    [handleOffer, handleAnswer, handleIceCandidate, handleRenegotiationOffer, cleanupPeer],
  );

  const processPendingOffers = useCallback(async () => {
    const ls = localStreamRef.current ?? new MediaStream();
    const offers = [...pendingOffersRef.current];
    pendingOffersRef.current = [];
    for (const pending of offers) {
      await handleOffer(pending.fromUserId, pending.offer, ls);
    }
  }, [handleOffer]);

  const createOffer = useCallback(
    async (remoteUserId: string, localStream: MediaStream) => {
      try {
        if (peersRef.current.has(remoteUserId)) return;

        const entry = createPeerConnection(remoteUserId, localStream);
        const offer = await entry.peerConnection.createOffer();
        await entry.peerConnection.setLocalDescription(offer);

        const offerData = entry.peerConnection.localDescription?.toJSON();
        if (offerData) {
          await sendSignaling('offer', remoteUserId, { offer: offerData });
          pendingOffersForRetryRef.current.set(remoteUserId, offerData);
        }
      } catch (err) {
        console.error(`[call] createOffer to ${remoteUserId} failed:`, err);
      }
    },
    [createPeerConnection, sendSignaling],
  );

  const startOfferRetry = useCallback(() => {
    if (offerRetryIntervalRef.current) return;
    offerRetryIntervalRef.current = setInterval(() => {
      if (destroyedRef.current) return;
      pendingOffersForRetryRef.current.forEach((offerData, remoteUserId) => {
        sendSignaling('offer', remoteUserId, { offer: offerData });
      });
    }, 3000);
  }, [sendSignaling]);

  const stopOfferRetry = useCallback(() => {
    if (offerRetryIntervalRef.current) {
      clearInterval(offerRetryIntervalRef.current);
      offerRetryIntervalRef.current = null;
    }
    pendingOffersForRetryRef.current.clear();
  }, []);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return false;
    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (!audioTrack) return false;
    audioTrack.enabled = !audioTrack.enabled;
    return !audioTrack.enabled;
  }, []);

  const toggleVideo = useCallback(() => {
    if (!localStreamRef.current) return false;
    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (!videoTrack) return false;
    videoTrack.enabled = !videoTrack.enabled;
    return videoTrack.enabled;
  }, []);

  const enableVideo = useCallback(async (): Promise<boolean> => {
    if (!localStreamRef.current) return false;
    const existingVideo = localStreamRef.current.getVideoTracks()[0];
    if (existingVideo) {
      existingVideo.enabled = true;
      return true;
    }
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
      });
      const videoTrack = videoStream.getVideoTracks()[0];
      localStreamRef.current.addTrack(videoTrack);
      peersRef.current.forEach((entry) => {
        // This addTrack fires `onnegotiationneeded` on each peer connection,
        // which now (see createPeerConnection above) triggers a real
        // renegotiate() -> offer/answer exchange, so the remote side
        // actually receives the new video track.
        entry.peerConnection.addTrack(videoTrack, localStreamRef.current!);
      });
      return true;
    } catch {
      return false;
    }
  }, []);

  const broadcastMute = useCallback((isMuted: boolean) => {
    const callId = callIdRef.current;
    if (!callId) return;
    void import('@/lib/call/call').then(({ updateCallParticipantMuted }) =>
      updateCallParticipantMuted(callId, isMuted),
    );
  }, []);

  const broadcastEndCall = useCallback(async () => {
    if (!callIdRef.current) return;
    try {
      const { data } = await platform
        .from('call_participants')
        .select('user_id')
        .eq('call_id', callIdRef.current);
      if (data) {
        await Promise.all(
          (data as any[])
            .filter((p) => p.user_id !== myUserIdRef.current)
            .map((p) => sendSignaling('end-call', p.user_id, {})),
        );
      }
    } catch (err) {
      console.error('[call] broadcastEndCall failed:', err);
    }
  }, [sendSignaling]);

  const screenStreamRef = useRef<MediaStream | null>(null);

  const startScreenShare = useCallback(async (): Promise<MediaStream | null> => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' } as any,
        audio: false,
      });
      screenStreamRef.current = stream;
      const videoTrack = stream.getVideoTracks()[0];
      peersRef.current.forEach((entry) => {
        const sender = entry.peerConnection.getSenders().find((s) => s.track?.kind === 'video');
        if (sender && localStreamRef.current) {
          sender.replaceTrack(videoTrack);
        }
      });
      videoTrack.onended = () => {
        const ls = screenStreamRef.current;
        if (ls) {
          ls.getTracks().forEach((t) => t.stop());
          screenStreamRef.current = null;
        }
        const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
        if (cameraTrack) {
          peersRef.current.forEach((entry) => {
            const sender = entry.peerConnection.getSenders().find((s) => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(cameraTrack);
          });
        }
      };
      return stream;
    } catch {
      return null;
    }
  }, []);

  const stopScreenShare = useCallback(() => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
    if (cameraTrack) {
      peersRef.current.forEach((entry) => {
        const sender = entry.peerConnection.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(cameraTrack);
      });
    }
  }, []);

  const getDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      audioInputs: devices.filter((d) => d.kind === 'audioinput'),
      videoInputs: devices.filter((d) => d.kind === 'videoinput'),
      audioOutputs: devices.filter((d) => d.kind === 'audiooutput'),
    };
  }, []);

  const getPeers = useCallback(() => peersRef.current, []);

  const resumeAllAudio = useCallback(async (): Promise<boolean> => {
    const attempts = Array.from(peersRef.current.entries()).map(([userId, entry]) => {
      if (!entry.remoteAudioElement) return Promise.resolve(true);
      return playRemoteAudio(userId, entry.remoteAudioElement);
    });
    const results = await Promise.all(attempts);
    return results.every(Boolean);
  }, [playRemoteAudio]);

  const switchDevice = useCallback(
    async (kind: 'audioinput' | 'videoinput', deviceId: string) => {
      if (!localStreamRef.current) return;
      const constraints: MediaStreamConstraints =
        kind === 'audioinput'
          ? { audio: { deviceId: { exact: deviceId } } }
          : { video: { deviceId: { exact: deviceId } } };
      try {
        const newStream = await navigator.mediaDevices.getUserMedia(constraints);
        const newTrack = newStream.getTracks()[0];
        if (!newTrack) return;
        const oldTrack = kind === 'audioinput'
          ? localStreamRef.current.getAudioTracks()[0]
          : localStreamRef.current.getVideoTracks()[0];
        if (oldTrack) {
          localStreamRef.current.removeTrack(oldTrack);
          oldTrack.stop();
        }
        localStreamRef.current.addTrack(newTrack);
        peersRef.current.forEach((entry) => {
          const sender = entry.peerConnection.getSenders().find((s) => s.track?.kind === newTrack.kind);
          if (sender) sender.replaceTrack(newTrack);
        });
      } catch { /* device switch failed */ }
    },
    [],
  );

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
    onRemoteStream: (cb: (userId: string, stream: MediaStream) => void) => {
      onRemoteStreamRef.current = cb;
    },
    onCallEnd: (cb: () => void) => {
      onCallEndRef.current = cb;
    },
    onPeerConnected: (cb: (userId: string) => void) => {
      onPeerConnectedRef.current = cb;
    },
    onAudioPlaybackBlocked: (cb: (blocked: boolean) => void) => {
      onAudioPlaybackBlockedRef.current = cb;
    },
    getPeers,
    getLocalStream: () => localStreamRef.current,
    getScreenStream: () => screenStreamRef.current,
    resumeAllAudio,
  };
}
