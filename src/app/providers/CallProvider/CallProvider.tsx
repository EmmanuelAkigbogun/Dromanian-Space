import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import {
  createCallSession,
  addCallParticipant,
  answerCall,
  endCall,
  declineCall,
  cancelCall,
  updateCallParticipantStatus,
  updateCallParticipantMuted,
  getCallParticipants,
  getCallSession,
} from '@/lib/call/call';
import { createTypedNotification } from '@/features/notifications/service';
import { useCallEngine } from '@/hooks/useCallEngine/useCallEngine';
import type { CallSession, CallParticipant, CallScreen } from '@/types';

interface DeviceInfo {
  deviceId: string;
  label: string;
  groupId: string;
}

interface CallContextValue {
  callScreen: CallScreen;
  currentCall: CallSession | null;
  participants: CallParticipant[];
  isMuted: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  isAccepting: boolean;
  callDuration: number;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  getPeers: () => Map<string, { peerConnection: RTCPeerConnection; remoteStream: MediaStream; remoteAudioElement: HTMLAudioElement | null; userId: string }>;
  startCall: (targetUserId: string, callType?: 'direct' | 'group' | 'channel', participantIds?: string[], withVideo?: boolean) => Promise<void>;
  acceptCall: (withVideo?: boolean) => Promise<void>;
  declineIncomingCall: () => Promise<void>;
  cancelOutgoingCall: () => Promise<void>;
  endActiveCall: () => Promise<void>;
  toggleMute: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => Promise<void>;
  getDevices: () => Promise<{ audioInputs: DeviceInfo[]; videoInputs: DeviceInfo[]; audioOutputs: DeviceInfo[] }>;
  switchDevice: (kind: 'audioinput' | 'videoinput', deviceId: string) => Promise<void>;
  setCallScreen: (screen: CallScreen) => void;
}

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const engine = useCallEngine();

  const [callScreen, setCallScreen] = useState<CallScreen>('none');
  const [currentCall, setCurrentCall] = useState<CallSession | null>(null);
  const [participants, setParticipants] = useState<CallParticipant[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());

  const currentCallRef = useRef<CallSession | null>(null);
  const callScreenRef = useRef<CallScreen>('none');
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const engineRef = useRef(engine);
  engineRef.current = engine;

  // FIX: deterministic guard for the caller's own participant-insert race.
  // Previously the code relied on `currentCallRef.current?.id === participant.call_id`
  // being set *before* the realtime INSERT event for the caller's own
  // `addCallParticipant` row arrived - a timing race, not a guarantee. When the
  // realtime round-trip won the race, the caller's own insert re-triggered
  // `engine.setupSignaling(...)`, tearing down and rebuilding the signaling
  // channel the caller was actively using to send its offer, causing
  // intermittent "sometimes it just doesn't connect" failures. Recording the
  // session id synchronously the instant it's created (well before any
  // participant row exists) removes the race entirely - no timing dependency.
  const outgoingCallIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => { currentCallRef.current = currentCall; }, [currentCall]);
  useEffect(() => { callScreenRef.current = callScreen; }, [callScreen]);

  useEffect(() => {
    if (callScreen === 'active' && currentCall?.started_at) {
      const update = () => {
        const elapsed = Math.floor((Date.now() - new Date(currentCall.started_at!).getTime()) / 1000);
        setCallDuration(elapsed);
      };
      update();
      const id = setInterval(update, 1000);
      return () => clearInterval(id);
    }
  }, [callScreen, currentCall?.started_at]);

  useEffect(() => {
    if (callScreen !== 'outgoing' || !currentCall?.id) return;
    const startMs = Date.now();
    const RINGING_TIMEOUT_MS = 45_000;
    const id = setInterval(async () => {
      if (Date.now() - startMs > RINGING_TIMEOUT_MS) {
        console.warn('[call] outgoing ringing timeout - cancelling');
        await engineRef.current.broadcastEndCall();
        engineRef.current.stopOfferRetry();
        await cancelCall(currentCall.id);
        engineRef.current.cleanupAll();
        resetState();
        return;
      }
      const s = await getCallSession(currentCall.id);
      if (!s) return;
      if (s.status === 'active') {
        setCurrentCall(s);
        setCallScreen('active');
      } else if (s.status !== 'ringing') {
        engineRef.current.stopOfferRetry();
        engineRef.current.cleanupAll();
        resetState();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [callScreen, currentCall?.id]);

  const resetState = useCallback(() => {
    // Clean up the outgoing-call marker so the set doesn't grow unbounded.
    if (currentCallRef.current) {
      outgoingCallIdsRef.current.delete(currentCallRef.current.id);
    }
    setCurrentCall(null);
    setParticipants([]);
    setCallScreen('none');
    setIsMuted(false);
    setIsVideoEnabled(false);
    setIsScreenSharing(false);
    setIsAccepting(false);
    setCallDuration(0);
    setLocalStream(null);
    setRemoteStreams(new Map());
  }, []);

  useEffect(() => {
    if (!userId || !currentWorkspace) return;
    const ch = supabase
      .channel(`user-calls:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'call_participants', filter: `user_id=eq.${userId}` },
        async (payload) => {
          const participant = payload.new as CallParticipant;
          const myUserId = userIdRef.current;

          // FIX: bail out immediately (synchronously, no race) if this insert
          // is for a call *we* just created as the caller.
          if (outgoingCallIdsRef.current.has(participant.call_id)) return;
          if (currentCallRef.current?.id === participant.call_id) return;
          if (!myUserId) return;

          engineRef.current.setupSignaling(participant.call_id, myUserId);

          const [session, parts] = await Promise.all([
            getCallSession(participant.call_id),
            getCallParticipants(participant.call_id),
          ]);
          if (!session || session.created_by === myUserId || session.status !== 'ringing') return;

          setCurrentCall(session);
          setParticipants(parts);
          setCallScreen('incoming');
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'call_sessions', filter: `workspace_id=eq.${currentWorkspace.id}` },
        (payload) => {
          const updated = payload.new as CallSession;
          const call = currentCallRef.current;
          const screen = callScreenRef.current;
          if (call?.id !== updated.id) return;

          // Refresh the session so fields the server/callee wrote are visible
          // here - without this, started_at stays null after the callee answers
          // and the call duration counter never ticks.
          setCurrentCall(updated);

          if (updated.status === 'active' && (screen === 'outgoing' || screen === 'incoming')) {
            setCallScreen('active');
          } else if (updated.status === 'ended' || updated.status === 'cancelled' || updated.status === 'declined') {
            engineRef.current.stopOfferRetry();
            engineRef.current.cleanupAll();
            resetState();
          }
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'call_participants', filter: `workspace_id=eq.${currentWorkspace.id}` },
        (payload) => {
          const row = payload.new as CallParticipant;
          if (currentCallRef.current?.id !== row.call_id) return;
          setParticipants((prev) => {
            const idx = prev.findIndex((p) => p.user_id === row.user_id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = row;
              return next;
            }
            return [...prev, row];
          });
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [userId, currentWorkspace?.id]);

  useEffect(() => {
    engine.onCallEnd(() => {
      engine.stopOfferRetry();
      engine.cleanupAll();
      resetState();
    });
    engine.onRemoteStream((remoteUserId, stream) => {
      setRemoteStreams((prev) => {
        const next = new Map(prev);
        next.set(remoteUserId, stream);
        return next;
      });
      const screen = callScreenRef.current;
      if (screen === 'outgoing') {
        console.log('[call] remote stream received - transitioning to active');
        setCallScreen('active');
      }
    });
    engine.onPeerConnected((_userId) => {
      const screen = callScreenRef.current;
      if (screen === 'outgoing') {
        console.log('[call] peer connected - transitioning to active');
        setCallScreen('active');
      }
    });
  }, []);

  useEffect(() => {
    if (callScreen === 'active') {
      engine.resumeAllAudio();
    }
  }, [callScreen, engine]);

  const startCall = useCallback(
    async (targetUserId: string, callType: 'direct' | 'group' | 'channel' = 'direct', participantIds: string[] = [], withVideo = false) => {
      if (!userId || !currentWorkspace) return;

      try {
        const stream = await engine.startLocalMedia(withVideo);
        if (!stream) return;
        setLocalStream(stream);
        setIsVideoEnabled(withVideo && stream.getVideoTracks().length > 0);

        let effectiveParticipantIds = participantIds;
        let effectiveCallType = callType;
        let sessionChannelId: string | null = null;

        if (callType === 'channel') {
          sessionChannelId = targetUserId;
          effectiveCallType = 'channel';
          const { data: members } = await supabase
            .from('channel_members')
            .select('user_id')
            .eq('channel_id', targetUserId);
          effectiveParticipantIds = (members ?? [])
            .map((m: any) => m.user_id as string)
            .filter((id) => id !== userId);
        }

        const session = await createCallSession(currentWorkspace.id, userId, effectiveCallType, { channelId: sessionChannelId ?? undefined, withVideo });
        if (!session) { engine.stopLocalMedia(); return; }

        // FIX: mark this call as "ours" the instant it exists - synchronously,
        // before any participant row (including our own) is inserted. This is
        // what makes the race-guard above deterministic instead of timing-dependent.
        outgoingCallIdsRef.current.add(session.id);

        const allParticipants = callType === 'channel'
          ? effectiveParticipantIds
          : [targetUserId, ...effectiveParticipantIds.filter((id) => id !== userId)];

        await Promise.all([
          addCallParticipant(session.id, userId).then(() => updateCallParticipantStatus(session.id, userId, 'connected')),
          ...allParticipants.map((pid) => addCallParticipant(session.id, pid)),
        ]);

        setCurrentCall(session);
        setCallScreen('outgoing');

        engine.setupSignaling(session.id, userId);

        for (const pid of allParticipants) {
          engine.createOffer(pid, stream);
        }
        engine.startOfferRetry();

        const notifCategory = callType === 'channel' ? 'channels' : 'messaging';
        const notifEntityType = callType === 'channel' ? 'channel' : 'message';
        for (const pid of allParticipants) {
          createTypedNotification(pid, 'mention',
            withVideo ? 'Incoming video call' : 'Incoming voice call',
            `${withVideo ? 'Video' : 'Voice'} call from ${userId}`,
            null, notifCategory, notifEntityType, session.id, userId, currentWorkspace.id);
        }
      } catch (err) {
        console.error('[call] startCall failed:', err);
        engine.cleanupAll();
        resetState();
      }
    },
    [userId, currentWorkspace, engine, resetState],
  );

  const acceptCall = useCallback(
    async (withVideo = false) => {
      if (!currentCall || !userId || isAccepting) return;

      setIsAccepting(true);
      try {
        const stream = await engine.startLocalMedia(withVideo);
        if (stream) {
          setLocalStream(stream);
          setIsVideoEnabled(withVideo && stream.getVideoTracks().length > 0);
        } else {
          console.warn('[call] startLocalMedia returned null - proceeding without local media');
        }

        await engine.processPendingOffers();

        answerCall(currentCall.id).catch((err) => {
          console.error('[call] answerCall DB update failed (non-fatal):', err);
        });
        updateCallParticipantStatus(currentCall.id, userId, 'connected').catch(() => { });

        engine.resumeAllAudio();

        setIsAccepting(false);
        setCallScreen('active');
      } catch (err) {
        console.error('[call] acceptCall failed:', err);
        engine.cleanupAll();
        resetState();
      }
    },
    [currentCall, userId, isAccepting, engine, resetState],
  );

  const declineIncomingCall = useCallback(async () => {
    if (!currentCall) return;
    await engine.broadcastEndCall();
    await declineCall(currentCall.id);
    (supabase as any)
      .rpc('cleanup_call_signaling', { p_call_id: currentCall.id })
      .then(() => {})
      .catch(() => { });
    engine.cleanupAll();
    resetState();
  }, [currentCall, engine, resetState]);

  const cancelOutgoingCall = useCallback(async () => {
    if (!currentCall) return;
    await engine.broadcastEndCall();
    await cancelCall(currentCall.id);
    (supabase as any)
      .rpc('cleanup_call_signaling', { p_call_id: currentCall.id })
      .then(() => {})
      .catch(() => { });
    engine.cleanupAll();
    resetState();
  }, [currentCall, engine, resetState]);

  const endActiveCall = useCallback(async () => {
    if (!currentCall || !userId) return;
    engine.stopOfferRetry();
    await Promise.all([
      engine.broadcastEndCall(),
      endCall(currentCall.id),
      updateCallParticipantStatus(currentCall.id, userId, 'left'),
    ]);
    (supabase as any)
      .rpc('cleanup_call_signaling', { p_call_id: currentCall.id })
      .then(() => {})
      .catch(() => { });
    engine.cleanupAll();
    resetState();
  }, [currentCall, userId, engine, resetState]);

  const toggleMute = useCallback(() => {
    const muted = engine.toggleMute();
    setIsMuted(muted);
    engine.broadcastMute(muted);
    if (currentCall && userId) updateCallParticipantMuted(currentCall.id, userId, muted);
  }, [engine, currentCall, userId]);

  const toggleVideo = useCallback(async () => {
    const ls = engine.getLocalStream();
    if (ls?.getVideoTracks()[0]) {
      setIsVideoEnabled(engine.toggleVideo());
    } else {
      setIsVideoEnabled(await engine.enableVideo());
    }
  }, [engine]);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      engine.stopScreenShare();
      setIsScreenSharing(false);
    } else {
      const s = await engine.startScreenShare();
      if (s) setIsScreenSharing(true);
    }
  }, [engine, isScreenSharing]);

  const getDevices = useCallback(async () => {
    const d = await engine.getDevices();
    return {
      audioInputs: d.audioInputs.map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId })),
      videoInputs: d.videoInputs.map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId })),
      audioOutputs: d.audioOutputs.map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId })),
    };
  }, [engine]);

  const switchDevice = useCallback(async (kind: 'audioinput' | 'videoinput', deviceId: string) => {
    await engine.switchDevice(kind, deviceId);
  }, [engine]);

  const value = useMemo<CallContextValue>(() => ({
    callScreen, currentCall, participants, isMuted, isVideoEnabled, isScreenSharing, isAccepting,
    callDuration, localStream, remoteStreams, getPeers: engine.getPeers,
    startCall, acceptCall, declineIncomingCall, cancelOutgoingCall, endActiveCall,
    toggleMute, toggleVideo, toggleScreenShare, getDevices, switchDevice, setCallScreen,
  }), [
    callScreen, currentCall, participants, isMuted, isVideoEnabled, isScreenSharing, isAccepting,
    callDuration, localStream, remoteStreams, engine.getPeers,
    startCall, acceptCall, declineIncomingCall, cancelOutgoingCall, endActiveCall,
    toggleMute, toggleVideo, toggleScreenShare, getDevices, switchDevice, setCallScreen,
  ]);

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCallContext(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCallContext must be used within CallProvider');
  return ctx;
}

export function useCallContextSafe(): CallContextValue | null {
  return useContext(CallContext);
}