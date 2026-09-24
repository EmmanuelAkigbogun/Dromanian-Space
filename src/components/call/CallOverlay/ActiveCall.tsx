import { useEffect, useRef, useState, useMemo, useCallback, memo } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useCallContext } from '@/app/providers/CallProvider/CallProvider';
import { useSpeakingIndicator } from '@/hooks/useCallEngine';
import { useNetworkQuality } from '@/hooks/useCallEngine';
import type { NetworkQuality } from '@/hooks/useCallEngine';
import { MeetingChat } from '../MeetingChat/MeetingChat';
import { Whiteboard } from '../Whiteboard/Whiteboard';
import styles from './ActiveCall.module.css';

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

type LayoutMode = 'grid' | 'active-speaker' | 'spotlight';

interface FloatingReaction {
  id: number;
  emoji: string;
  x: number;
  userId: string;
}

interface RemoteRaisedHand {
  userId: string;
  raised: boolean;
}

interface RemoteScreenSharer {
  userId: string;
  sharing: boolean;
}

interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  isMuted?: boolean;
  isLocal?: boolean;
  isSpeaking?: boolean;
  handRaised?: boolean;
  isScreenSharing?: boolean;
}

function VideoTileImpl({ stream, label, isMuted, isLocal, isSpeaking, handRaised, isScreenSharing }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [trackVersion, setTrackVersion] = useState(0);

  useEffect(() => {
    if (!stream) return;
    const handleTrackChange = () => setTrackVersion((v) => v + 1);
    stream.addEventListener('addtrack', handleTrackChange);
    stream.addEventListener('removetrack', handleTrackChange);
    return () => {
      stream.removeEventListener('addtrack', handleTrackChange);
      stream.removeEventListener('removetrack', handleTrackChange);
    };
  }, [stream]);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream, trackVersion]);

  const hasVideo = stream?.getVideoTracks().some((t) => t.enabled) ?? false;

  return (
    <div className={`${styles.videoTile} ${isLocal ? styles.localTile : ''} ${isSpeaking ? styles.speakingTile : ''}`}>
      {isScreenSharing && (
        <div className={styles.screenShareBadge}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          Presenting
        </div>
      )}
      {hasVideo ? (
        <video ref={videoRef} autoPlay playsInline muted={isLocal} className={styles.videoElement} />
      ) : (
        <div className={styles.videoPlaceholder}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </div>
      )}
      <div className={styles.videoLabel}>
        <span>{label}</span>
        {isMuted && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
          </svg>
        )}
        {isSpeaking && <div className={styles.speakingIndicator} />}
        {handRaised && <div className={styles.handRaisedBadge}>✋</div>}
      </div>
    </div>
  );
}

const VideoTile = memo(VideoTileImpl);

function NetworkBadge({ quality }: { quality: NetworkQuality }) {
  const colorMap: Record<NetworkQuality, string> = {
    excellent: '#22c55e',
    good: '#22c55e',
    fair: '#f59e0b',
    poor: '#ef4444',
    unknown: '#6b7280',
  };
  const labelMap: Record<NetworkQuality, string> = {
    excellent: 'Excellent',
    good: 'Good',
    fair: 'Fair',
    poor: 'Poor',
    unknown: '--',
  };

  return (
    <span className={styles.networkBadge} title={`Connection: ${labelMap[quality]}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill={colorMap[quality]} stroke="none">
        <circle cx="3" cy="17" r="2" />
        <circle cx="8" cy="13" r="2" />
        <circle cx="13" cy="17" r="2" />
        <circle cx="18" cy="13" r="2" />
      </svg>
      <span style={{ color: colorMap[quality], fontSize: 11, fontWeight: 600 }}>
        {labelMap[quality]}
      </span>
    </span>
  );
}

export function ActiveCall() {
  const { userId } = useAuth();
  const {
    currentCall,
    participants,
    isMuted,
    isVideoEnabled,
    isScreenSharing,
    callDuration,
    localStream,
    remoteStreams,
    toggleMute,
    toggleVideo,
    toggleScreenShare,
    endActiveCall,
    getPeers,
  } = useCallContext();

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [floatingReactions, setFloatingReactions] = useState<FloatingReaction[]>([]);
  const [remoteRaisedHands, setRemoteRaisedHands] = useState<Map<string, boolean>>(new Map());
  const [remoteScreenSharers, setRemoteScreenSharers] = useState<Map<string, boolean>>(new Map());
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('grid');
  const containerRef = useRef<HTMLDivElement>(null);
  const reactionIdRef = useRef(0);
  const channelRef = useRef<any>(null);

  const connectedParticipants = useMemo(
    () => participants.filter((p) => p.status === 'connected'),
    [participants],
  );

  const speakingUsers = useSpeakingIndicator(remoteStreams);
  const { quality: networkQuality } = useNetworkQuality(getPeers);

  // Fetch profile display names for participants
  const [profileNames, setProfileNames] = useState<Map<string, string>>(new Map());
  const participantIdsKey = useMemo(
    () => connectedParticipants.map((p) => p.user_id).sort().join(','),
    [connectedParticipants],
  );
  useEffect(() => {
    if (!participantIdsKey) return;
    const ids = participantIdsKey.split(',');
    supabase
      .from('profiles')
      .select('id, display_name, username')
      .in('id', ids)
      .then(({ data }) => {
        if (!data) return;
        const map = new Map<string, string>();
        for (const row of data) {
          map.set(row.id, row.display_name || row.username || row.id.slice(0, 8));
        }
        setProfileNames(map);
      });
  }, [participantIdsKey]);

  const activeSpeakerId = useMemo(() => {
    if (speakingUsers.size > 0) return speakingUsers.values().next().value;
    if (connectedParticipants.length > 0) return connectedParticipants[0]?.user_id;
    return null;
  }, [speakingUsers, connectedParticipants]);

  // Setup meeting collaboration channel for reactions, raise hand, screen share state
  useEffect(() => {
    if (!currentCall?.id || !userId) return;

    const ch = supabase.channel(`meeting:${currentCall.id}`);

    ch.on('broadcast', { event: 'reaction' }, (payload) => {
      const data = payload.payload as { emoji: string; userId: string };
      if (data.userId === userId) return;
      const id = reactionIdRef.current++;
      const x = 20 + Math.random() * 60;
      setFloatingReactions((prev) => [...prev, { id, emoji: data.emoji, x, userId: data.userId }]);
      setTimeout(() => {
        setFloatingReactions((prev) => prev.filter((r) => r.id !== id));
      }, 3000);
    });

    ch.on('broadcast', { event: 'raise-hand' }, (payload) => {
      const data = payload.payload as { userId: string; raised: boolean };
      if (data.userId === userId) return;
      setRemoteRaisedHands((prev) => {
        const next = new Map(prev);
        next.set(data.userId, data.raised);
        return next;
      });
    });

    ch.on('broadcast', { event: 'screen-share-state' }, (payload) => {
      const data = payload.payload as { userId: string; sharing: boolean };
      if (data.userId === userId) return;
      setRemoteScreenSharers((prev) => {
        const next = new Map(prev);
        if (data.sharing) {
          next.set(data.userId, true);
        } else {
          next.delete(data.userId);
        }
        return next;
      });
    });

    ch.subscribe();
    channelRef.current = ch;

    return () => {
      supabase.removeChannel(ch);
    };
  }, [currentCall?.id, userId]);

  // Broadcast reactions to all participants
  const sendReaction = useCallback((emoji: string) => {
    const id = reactionIdRef.current++;
    const x = 20 + Math.random() * 60;
    setFloatingReactions((prev) => [...prev, { id, emoji, x, userId: userId ?? '' }]);
    setShowReactions(false);
    setTimeout(() => {
      setFloatingReactions((prev) => prev.filter((r) => r.id !== id));
    }, 3000);

    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'reaction',
        payload: { emoji, userId },
      });
    }
  }, [userId]);

  // Broadcast raise hand state
  const toggleHandRaised = useCallback(() => {
    const newState = !handRaised;
    setHandRaised(newState);
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'raise-hand',
        payload: { userId, raised: newState },
      });
    }
  }, [handRaised, userId]);

  // Broadcast screen sharing state when it changes
  useEffect(() => {
    if (!channelRef.current || !userId) return;
    channelRef.current.send({
      type: 'broadcast',
      event: 'screen-share-state',
      payload: { userId, sharing: isScreenSharing },
    });
  }, [isScreenSharing, userId]);

  const isGroup = connectedParticipants.length > 2;
  const hasAnyVideo = isVideoEnabled || Array.from(remoteStreams.values()).some((s) => s.getVideoTracks().some((t) => t.enabled));
  const hasRaisedHands = remoteRaisedHands.size > 0;
  const hasPresenters = remoteScreenSharers.size > 0 || isScreenSharing;

  const handleFullscreen = async () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      await containerRef.current.requestFullscreen();
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const handlePiP = async () => {
    const video = containerRef.current?.querySelector('video');
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (video.readyState >= 2) {
        await video.requestPictureInPicture();
      }
    } catch { /* PiP not supported */ }
  };

  const layoutIcon = layoutMode === 'grid' ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
    </svg>
  ) : layoutMode === 'active-speaker' ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );

  const remoteParticipants = useMemo(
    () => connectedParticipants.filter((p) => p.user_id !== userId),
    [connectedParticipants, userId],
  );

  const renderVideoGrid = () => {
    const allTiles = [
      { userId: '__local__', stream: localStream, label: 'You', isMuted, isLocal: true as const, handRaised: false, isScreenSharing: isScreenSharing },
      ...remoteParticipants.map((p) => ({
        userId: p.user_id,
        stream: remoteStreams.get(p.user_id) ?? null,
        label: profileNames.get(p.user_id) || p.user_id.slice(0, 8),
        isMuted: p.is_muted,
        isLocal: false as const,
        handRaised: remoteRaisedHands.get(p.user_id) ?? false,
        isScreenSharing: remoteScreenSharers.get(p.user_id) ?? false,
      })),
    ];

    if (layoutMode === 'spotlight' && activeSpeakerId) {
      const spotlightUser = allTiles.find((t) => t.userId === activeSpeakerId) ?? allTiles[0];
      const others = allTiles.filter((t) => t.userId !== spotlightUser.userId);
      return (
        <div className={styles.spotlightLayout}>
          <div className={styles.spotlightMain}>
            <VideoTile
              stream={spotlightUser.stream}
              label={spotlightUser.label}
              isMuted={spotlightUser.isMuted}
              isLocal={spotlightUser.isLocal}
              isSpeaking={speakingUsers.has(spotlightUser.userId)}
              handRaised={spotlightUser.handRaised}
              isScreenSharing={spotlightUser.isScreenSharing}
            />
          </div>
          <div className={styles.spotlightSidebar}>
            {others.map((t) => (
              <VideoTile
                key={t.userId}
                stream={t.stream}
                label={t.label}
                isMuted={t.isMuted}
                isLocal={t.isLocal}
                isSpeaking={speakingUsers.has(t.userId)}
                handRaised={t.handRaised}
                isScreenSharing={t.isScreenSharing}
              />
            ))}
          </div>
        </div>
      );
    }

    if (layoutMode === 'active-speaker' && activeSpeakerId) {
      const speakerTile = allTiles.find((t) => t.userId === activeSpeakerId) ?? allTiles[0];
      const others = allTiles.filter((t) => t.userId !== speakerTile.userId);
      return (
        <div className={styles.activeSpeakerLayout}>
          <div className={styles.activeSpeakerMain}>
            <VideoTile
              stream={speakerTile.stream}
              label={speakerTile.label}
              isMuted={speakerTile.isMuted}
              isLocal={speakerTile.isLocal}
              isSpeaking={speakingUsers.has(speakerTile.userId)}
              handRaised={speakerTile.handRaised}
              isScreenSharing={speakerTile.isScreenSharing}
            />
          </div>
          {others.length > 0 && (
            <div className={styles.activeSpeakerStrip}>
              {others.map((t) => (
                <VideoTile
                  key={t.userId}
                  stream={t.stream}
                  label={t.label}
                  isMuted={t.isMuted}
                  isLocal={t.isLocal}
                  isSpeaking={speakingUsers.has(t.userId)}
                  handRaised={t.handRaised}
                  isScreenSharing={t.isScreenSharing}
                />
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className={styles.videoGrid}>
        {allTiles.map((t) => (
          <VideoTile
            key={t.userId}
            stream={t.stream}
            label={t.label}
            isMuted={t.isMuted}
            isLocal={t.isLocal}
            isSpeaking={speakingUsers.has(t.userId)}
            handRaised={t.handRaised}
            isScreenSharing={t.isScreenSharing}
          />
        ))}
      </div>
    );
  };

  return (
    <div ref={containerRef} className={`${styles.container} ${hasAnyVideo ? styles.videoMode : ''} ${isFullscreen ? styles.fullscreen : ''}`}>
      {floatingReactions.map((r) => (
        <div key={r.id} className={styles.floatingReaction} style={{ left: `${r.x}%` }}>
          {r.emoji}
        </div>
      ))}

      <div className={styles.header}>
        <h2 className={styles.title}>
          {currentCall?.call_type === 'group' ? 'Group' : currentCall?.call_type === 'channel' ? 'Channel' : 'Voice'} Call
        </h2>
        <span className={styles.duration}>{formatDuration(callDuration)}</span>
        <span className={styles.participantCount}>{connectedParticipants.length} participant{connectedParticipants.length !== 1 ? 's' : ''}</span>
        {hasRaisedHands && <span className={styles.handIndicator}>✋ {remoteRaisedHands.size}</span>}
        {hasPresenters && <span className={styles.presentingIndicator}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          {isScreenSharing ? 'You' : remoteScreenSharers.size} presenting
        </span>}
        <NetworkBadge quality={networkQuality} />
      </div>

      {hasAnyVideo ? (
        renderVideoGrid()
      ) : (
        <div className={styles.participants}>
          {remoteParticipants.map((p) => (
            <div key={p.user_id} className={`${styles.participant} ${speakingUsers.has(p.user_id) ? styles.participantSpeaking : ''}`}>
              <div className={styles.participantAvatar}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                {speakingUsers.has(p.user_id) && <div className={styles.speakingRing} />}
                {remoteRaisedHands.get(p.user_id) && <div className={styles.avatarHandRaised}>✋</div>}
              </div>
              <span className={styles.participantName}>
                {profileNames.get(p.user_id) || p.user_id.slice(0, 8)}
                {p.is_muted && <span className={styles.mutedIndicator}> (muted)</span>}
                {remoteRaisedHands.get(p.user_id) && <span className={styles.handIndicator}> ✋</span>}
                {remoteScreenSharers.get(p.user_id) && <span className={styles.presentingIndicator}> 📺</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {showParticipants && (
        <div className={styles.participantSidebar}>
          <h3>Participants ({connectedParticipants.length})</h3>
          {connectedParticipants.map((p) => (
            <div key={p.user_id} className={styles.participantListItem}>
              <div className={styles.participantInfo}>
                <span>{profileNames.get(p.user_id) || p.user_id.slice(0, 12)}</span>
                {p.is_muted && <span className={styles.mutedBadge}>Muted</span>}
                {speakingUsers.has(p.user_id) && <span className={styles.speakingBadge}>Speaking</span>}
                {remoteRaisedHands.get(p.user_id) && <span className={styles.handBadge}>✋ Hand raised</span>}
                {remoteScreenSharers.get(p.user_id) && <span className={styles.screenShareBadge}>Presenting</span>}
              </div>
              <div className={styles.participantActions}>
                {p.user_id !== currentCall?.created_by && (
                  <button
                    type="button"
                    className={styles.participantActionButton}
                    title="Mute participant"
                    onClick={async () => {
                      if (!currentCall) return;
                      const { updateCallParticipantMuted } = await import('@/lib/call/call');
                      await updateCallParticipantMuted(currentCall.id, p.user_id, !p.is_muted);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={styles.controls}>
        <button
          type="button"
          className={`${styles.controlButton} ${isMuted ? styles.controlButtonActive : ''}`}
          onClick={toggleMute}
          aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          title={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          )}
        </button>

        <button
          type="button"
          className={`${styles.controlButton} ${isVideoEnabled ? styles.controlButtonActive : ''}`}
          onClick={toggleVideo}
          aria-label={isVideoEnabled ? 'Turn off camera' : 'Turn on camera'}
          title={isVideoEnabled ? 'Camera Off' : 'Camera On'}
        >
          {isVideoEnabled ? (
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

        <button
          type="button"
          className={`${styles.controlButton} ${isScreenSharing ? styles.controlButtonActive : ''}`}
          onClick={toggleScreenShare}
          aria-label={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}
          title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        </button>

        {hasAnyVideo && (
          <>
            <button
              type="button"
              className={`${styles.controlButton} ${styles.layoutButton}`}
              onClick={() => {
                const modes: LayoutMode[] = ['grid', 'active-speaker', 'spotlight'];
                const idx = modes.indexOf(layoutMode);
                setLayoutMode(modes[(idx + 1) % modes.length]);
              }}
              aria-label="Change layout"
              title={`Layout: ${layoutMode.replace('-', ' ')}`}
            >
              {layoutIcon}
            </button>
            <button
              type="button"
              className={styles.controlButton}
              onClick={handlePiP}
              aria-label="Picture in Picture"
              title="Picture in Picture"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <rect x="11" y="9" width="9" height="7" rx="1" ry="1" fill="currentColor" opacity="0.3" />
              </svg>
            </button>
            <button
              type="button"
              className={styles.controlButton}
              onClick={handleFullscreen}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {isFullscreen ? (
                  <>
                    <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                    <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                    <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                    <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                  </>
                ) : (
                  <>
                    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                  </>
                )}
              </svg>
            </button>
          </>
        )}

        <button
          type="button"
          className={`${styles.controlButton} ${showParticipants ? styles.controlButtonActive : ''}`}
          onClick={() => setShowParticipants(!showParticipants)}
          aria-label="Toggle participant list"
          title="Participants"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </button>

        <MeetingChat callId={currentCall?.id ?? ''} channelId={currentCall?.channel_id ?? undefined} />

        <Whiteboard callId={currentCall?.id ?? ''} />

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className={styles.controlButton}
            onClick={() => setShowReactions(!showReactions)}
            aria-label="Send reaction"
            title="Reactions"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </button>
          {showReactions && (
            <div className={styles.reactionPicker}>
              {['👍', '❤️', '👏', '🎉', '😂', '👋', '🔥', '💯'].map((emoji) => (
                <button key={emoji} type="button" className={styles.reactionEmoji} onClick={() => sendReaction(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className={`${styles.controlButton} ${handRaised ? styles.controlButtonActive : ''}`}
          onClick={toggleHandRaised}
          aria-label={handRaised ? 'Lower hand' : 'Raise hand'}
          title={handRaised ? 'Lower Hand' : 'Raise Hand'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
            <path d="M10 11V6" />
            <path d="M14 11V5" />
            <path d="M18 11V7" />
            <path d="M18 11a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-3" />
            <path d="M6 15l-2 2" />
          </svg>
        </button>

        <button
          type="button"
          className={`${styles.controlButton} ${styles.endCallButton}`}
          onClick={endActiveCall}
          aria-label="End call"
          title="End Call"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            <line x1="23" y1="1" x2="1" y2="23" />
          </svg>
        </button>
      </div>
    </div>
  );
}
