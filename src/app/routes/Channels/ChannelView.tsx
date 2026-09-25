import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useChannel } from '@/hooks/useChannel';
import { useDmDisplayNames } from '@/hooks/useDmDisplayNames';
import { useThread } from '@/app/providers/ThreadProvider';
import { MessageProvider } from '@/app/providers/MessageProvider';
import { EditProvider } from '@/app/providers/EditProvider';
import { ChannelLoading, ChannelNotFound } from '@/components/channel';
import { Button } from '@/components/ui/Button';
import { CreateChannelDialog } from '@/components/channel/CreateChannelDialog';
import { EditChannelDialog } from '@/components/channel/EditChannelDialog';
import { DeleteChannelDialog } from '@/components/channel/DeleteChannelDialog';
import { ArchiveChannelDialog } from '@/components/channel/ArchiveChannelDialog';
import { LeaveChannelDialog } from '@/components/channel/LeaveChannelDialog';
import { InviteToChannelDialog } from '@/components/channel/InviteToChannelDialog';
import { JoinChannelButton } from '@/components/channel/JoinChannelButton';
import { ChannelActionsMenu } from '@/components/channel/ChannelActionsMenu';
import { MessageList, PinnedMessagesPanel } from '@/components/message';
import { CallButton } from '@/components/call';
import type { Channel } from '@/types';
import styles from './Channels.module.css';

export function ChannelView() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { currentChannel, isLoading, error, switchChannel, hasChannels, isMember, memberCounts } = useChannel();
  const dmDisplayNames = useDmDisplayNames();
  const { activeThread } = useThread();
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [deletingChannel, setDeletingChannel] = useState<Channel | null>(null);
  const [archivingChannel, setArchivingChannel] = useState<Channel | null>(null);
  const [leavingChannel, setLeavingChannel] = useState<Channel | null>(null);
  const [invitingChannel, setInvitingChannel] = useState<Channel | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [showPinned, setShowPinned] = useState(false);

  useEffect(() => {
    if (slug && currentChannel?.slug !== slug) {
      switchChannel(slug);
    }
  }, [slug, currentChannel?.slug, switchChannel]);

  if (isLoading) {
    return <ChannelLoading />;
  }

  if (error) {
    if (error === 'Channel not found') {
      return <ChannelNotFound />;
    }
    // Transient failure (e.g. a hiccup in the slug lookup) — offer a retry
    // instead of pretending the channel doesn't exist.
    return (
      <div className={styles.channelContent}>
        <div className={styles.channelViewError}>
          <span className={styles.channelViewErrorIcon}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </span>
          <span className={styles.channelViewErrorText}>{error}</span>
          <div className={styles.channelViewErrorActions}>
            <Button variant="secondary" onClick={() => slug && switchChannel(slug)}>
              Try again
            </Button>
            <Button variant="ghost" onClick={() => navigate('/channels')}>
              Back to channels
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!hasChannels) {
    return <Navigate to="/channels" replace />;
  }

  if (!currentChannel) {
    return <ChannelNotFound />;
  }

  const isUserMember = isMember(currentChannel.id);
  const canJoin = !currentChannel.is_private && !isUserMember;

  return (
    <div className={styles.channelView}>
      <div className={styles.channelHeader}>
        <div className={styles.channelHeaderContent}>
          <div className={styles.channelHeaderText}>
            <h2 className={styles.channelTitle}># {dmDisplayNames[currentChannel.id] ?? currentChannel.name}</h2>
            <div className={styles.channelHeaderMeta}>
              <span className={styles.memberCount}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                {memberCounts[currentChannel.id] ?? 0} members
              </span>
            </div>
            {currentChannel.topic && (
              <p className={styles.channelTopic}>{currentChannel.topic}</p>
            )}
            {currentChannel.description && !currentChannel.topic && (
              <p className={styles.channelDescription}>{currentChannel.description}</p>
            )}
          </div>
          <div className={styles.channelHeaderActions}>
            <CallButton
              channelId={currentChannel.id}
              callType="channel"
            />
            {canJoin && (
              <JoinChannelButton
                channelId={currentChannel.id}
                channelName={currentChannel.name}
              />
            )}
            {isUserMember && (
              <ChannelActionsMenu
                channel={currentChannel}
                onEdit={() => setEditingChannel(currentChannel)}
                onArchive={() => setArchivingChannel(currentChannel)}
                onDelete={() => setDeletingChannel(currentChannel)}
                onLeave={() => setLeavingChannel(currentChannel)}
                onInvite={currentChannel.is_private ? () => setInvitingChannel(currentChannel) : undefined}
                onCreateChannel={() => setIsCreateOpen(true)}
                onTogglePinned={() => setShowPinned((prev) => !prev)}
                pinnedOpen={showPinned}
              />
            )}
          </div>
        </div>
      </div>

      {isUserMember ? (
        <div className={styles.channelBody}>
          <MessageProvider>
            <EditProvider>
              <MessageList />
            </EditProvider>
          </MessageProvider>
          {showPinned && (
            <div className={`${styles.pinnedPanel} ${activeThread ? styles.pinnedPanelWithThread : ''}`}>
              <PinnedMessagesPanel
                channelId={currentChannel.id}
                onClose={() => setShowPinned(false)}
              />
            </div>
          )}
        </div>
      ) : (
        <div className={styles.channelContent}>
          <p className={styles.comingSoon}>
            {canJoin ? 'Join this channel to start messaging.' : 'You don\'t have access to this channel.'}
          </p>
        </div>
      )}

      {editingChannel && (
        <EditChannelDialog
          open={!!editingChannel}
          onClose={() => setEditingChannel(null)}
          channel={editingChannel}
        />
      )}

      {deletingChannel && (
        <DeleteChannelDialog
          open={!!deletingChannel}
          onClose={() => setDeletingChannel(null)}
          channel={deletingChannel}
        />
      )}

      {archivingChannel && (
        <ArchiveChannelDialog
          open={!!archivingChannel}
          onClose={() => setArchivingChannel(null)}
          channel={archivingChannel}
        />
      )}

      {leavingChannel && (
        <LeaveChannelDialog
          open={!!leavingChannel}
          onClose={() => setLeavingChannel(null)}
          channel={leavingChannel}
        />
      )}

      {invitingChannel && (
        <InviteToChannelDialog
          open={!!invitingChannel}
          onClose={() => setInvitingChannel(null)}
          channel={invitingChannel}
        />
      )}

      <CreateChannelDialog open={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
    </div>
  );
}
