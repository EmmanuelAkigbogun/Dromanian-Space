import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannel } from '@/hooks/useChannel';
import { useWorkspace } from '@/hooks/useWorkspace';
import { getArchivedChannels } from '@/lib/channel';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { SearchInput } from '@/components/ui/SearchInput';
import { useDmDisplayNames } from '@/hooks/useDmDisplayNames';
import { ChannelEmpty } from '@/components/channel';
import { CreateChannelDialog } from '@/components/channel/CreateChannelDialog';
import { EditChannelDialog } from '@/components/channel/EditChannelDialog';
import { DeleteChannelDialog } from '@/components/channel/DeleteChannelDialog';
import { ArchiveChannelDialog } from '@/components/channel/ArchiveChannelDialog';
import { LeaveChannelDialog } from '@/components/channel/LeaveChannelDialog';
import { JoinChannelButton } from '@/components/channel/JoinChannelButton';
import { ChannelActionsMenu } from '@/components/channel/ChannelActionsMenu';
import type { Channel } from '@/types';
import styles from './Channels.module.css';

type FilterType = 'all' | 'public' | 'private' | 'joined' | 'not-joined';

export function Channels() {
  const navigate = useNavigate();
  const { currentWorkspace } = useWorkspace();
  const { channels, currentChannel, isLoading, hasChannels, isMember, memberCounts, restoreChannel, error, refreshChannels, clearError } = useChannel();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [deletingChannel, setDeletingChannel] = useState<Channel | null>(null);
  const [archivingChannel, setArchivingChannel] = useState<Channel | null>(null);
  const [leavingChannel, setLeavingChannel] = useState<Channel | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedChannels, setArchivedChannels] = useState<Channel[]>([]);
  const [isLoadingArchived, setIsLoadingArchived] = useState(false);
  const [archivedError, setArchivedError] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<FilterType>('all');

  const dmDisplayNames = useDmDisplayNames();

  const displayName = useCallback(
    (channel: Channel) => dmDisplayNames[channel.id] ?? channel.name,
    [dmDisplayNames],
  );

  const isDm = useCallback(
    (channel: Channel) => Boolean(dmDisplayNames[channel.id]),
    [dmDisplayNames],
  );

  const filteredChannels = useMemo(() => {
    let result = channels;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((c) => {
        const name = displayName(c).toLowerCase();
        return (
          name.includes(q) ||
          (c.description && c.description.toLowerCase().includes(q)) ||
          (c.topic && c.topic.toLowerCase().includes(q))
        );
      });
    }

    if (filterType === 'public') {
      result = result.filter((c) => !c.is_private);
    } else if (filterType === 'private') {
      result = result.filter((c) => c.is_private);
    } else if (filterType === 'joined') {
      result = result.filter((c) => isMember(c.id));
    } else if (filterType === 'not-joined') {
      result = result.filter((c) => !isMember(c.id));
    }

    return result;
  }, [channels, searchQuery, filterType, isMember, displayName]);

  const fetchArchived = useCallback(async () => {
    if (!currentWorkspace) return;
    setIsLoadingArchived(true);
    setArchivedError(false);
    try {
      const data = await getArchivedChannels(currentWorkspace.id);
      setArchivedChannels(data);
    } catch {
      setArchivedError(true);
    } finally {
      setIsLoadingArchived(false);
    }
  }, [currentWorkspace]);

  useEffect(() => {
    if (showArchived) {
      fetchArchived();
    }
  }, [showArchived, fetchArchived]);

  const handleRestore = useCallback(async (channel: Channel) => {
    await restoreChannel(channel.id);
    setArchivedChannels((prev) => prev.filter((c) => c.id !== channel.id));
    toast({ description: `#${channel.name} restored`, variant: 'success' });
  }, [restoreChannel, toast]);

  if (isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.pageHeader}>
          <h2 className={styles.pageTitle}>Channels</h2>
        </div>
        <div className={styles.pageContent}>
          <div className={styles.loadingGrid}>
            {[1, 2, 3].map((i) => (
              <div key={i} className={styles.channelCardSkeleton} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error && channels.length === 0 && !showArchived) {
    return (
      <div className={styles.page}>
        <div className={styles.pageHeader}>
          <h2 className={styles.pageTitle}>Channels</h2>
        </div>
        <div className={styles.pageContent}>
          <div className={styles.errorState}>
            <span className={styles.errorIcon}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </span>
            <span className={styles.errorText}>{error}</span>
            <Button
              variant="secondary"
              onClick={() => {
                clearError();
                refreshChannels();
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!hasChannels && !showArchived) {
    return (
      <div className={styles.page}>
        <div className={styles.pageHeader}>
          <h2 className={styles.pageTitle}>Channels</h2>
          <div className={styles.tabs}>
            <button type="button" className={`${styles.tab} ${styles.tabActive}`}>Channels</button>
            <button type="button" className={styles.tab} onClick={() => setShowArchived(true)}>Archived</button>
          </div>
        </div>
        <ChannelEmpty onCreateChannel={() => setIsCreateOpen(true)} />
        <CreateChannelDialog open={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div className={styles.pageHeaderRow}>
          <div>
            <h2 className={styles.pageTitle}>Channels</h2>
            <p className={styles.pageDescription}>Browse and manage your team channels.</p>
          </div>
          {!showArchived && (
            <button
              type="button"
              className={styles.createButton}
              onClick={() => setIsCreateOpen(true)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Create channel
            </button>
          )}
        </div>
        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${!showArchived ? styles.tabActive : ''}`}
            onClick={() => setShowArchived(false)}
          >
            Channels
          </button>
          <button
            type="button"
            className={`${styles.tab} ${showArchived ? styles.tabActive : ''}`}
            onClick={() => setShowArchived(true)}
          >
            Archived
          </button>
        </div>
      </div>

      {!showArchived && channels.length > 0 && (
        <div className={styles.toolbar}>
          <SearchInput
            placeholder="Search channels..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onClear={() => setSearchQuery('')}
            className={styles.searchInput}
          />
          <div className={styles.filterRow}>
            {(['all', 'public', 'private', 'joined', 'not-joined'] as FilterType[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`${styles.filterButton} ${filterType === f ? styles.filterActive : ''}`}
                onClick={() => setFilterType(f)}
              >
                {f === 'not-joined' ? 'Not joined' : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={styles.pageContent}>
        {showArchived ? (
          isLoadingArchived ? (
            <div className={styles.loadingGrid}>
              {[1, 2, 3].map((i) => (
                <div key={i} className={styles.channelCardSkeleton} />
              ))}
            </div>
          ) : archivedError ? (
            <div className={styles.emptyState}>
              <span className={styles.errorText}>Failed to load archived channels.</span>
              <Button variant="secondary" onClick={fetchArchived}>Try again</Button>
            </div>
          ) : archivedChannels.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyText}>No archived channels.</span>
            </div>
          ) : (
            <div className={styles.channelGrid}>
              {archivedChannels.map((channel) => (
                <div
                  key={channel.id}
                  className={styles.channelCard}
                >
                  <div className={styles.channelCardBody}>
                    <div className={styles.channelIcon}>
                      <span className={styles.hash}>#</span>
                    </div>
                    <div className={styles.channelInfo}>
                      <span className={styles.channelName}>{channel.name}</span>
                      {channel.description && (
                        <span className={styles.channelDescription}>{channel.description}</span>
                      )}
                      <span className={styles.archivedDate}>
                        Archived {new Date(channel.archived_at!).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <div className={styles.channelCardActions}>
                    <button
                      type="button"
                      className={styles.restoreButton}
                      onClick={() => handleRestore(channel)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="1 4 1 10 7 10" />
                        <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
                      </svg>
                      Restore
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          filteredChannels.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyText}>
                {searchQuery || filterType !== 'all'
                  ? 'No channels match your filters.'
                  : 'No channels yet.'}
              </span>
            </div>
          ) : (
          <div className={styles.channelGrid}>
            {filteredChannels.map((channel) => {
            const isUserMember = isMember(channel.id);
            const canJoin = !channel.is_private && !isUserMember;

            return (
              <div
                key={channel.id}
                className={`${styles.channelCard} ${currentChannel?.id === channel.id ? styles.channelCardActive : ''}`}
              >
                <button
                  className={styles.channelCardBody}
                  onClick={() => navigate(`/channels/${channel.slug}`)}
                  type="button"
                >
                  <div className={styles.channelIcon}>
                    <span className={styles.hash}>{isDm(channel) ? '@' : '#'}</span>
                  </div>
                  <div className={styles.channelInfo}>
                    <span className={styles.channelName}>{displayName(channel)}</span>
                    {channel.topic && (
                      <span className={styles.channelTopic}>{channel.topic}</span>
                    )}
                    {!channel.topic && channel.description && (
                      <span className={styles.channelDescription}>{channel.description}</span>
                    )}
                  </div>
                  <div className={styles.channelMeta}>
                    <span className={styles.memberCount}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                      {memberCounts[channel.id] ?? 0}
                    </span>
                    {channel.is_private && (
                      <span className={styles.privateBadge}>Private</span>
                    )}
                    {isUserMember && (
                      <span className={styles.memberBadge}>Joined</span>
                    )}
                  </div>
                </button>
                <div className={styles.channelCardActions}>
                  {canJoin && (
                    <JoinChannelButton
                      channelId={channel.id}
                      channelName={channel.name}
                      variant="card"
                    />
                  )}
                  {isUserMember && (
                    <ChannelActionsMenu
                      channel={channel}
                      onEdit={() => setEditingChannel(channel)}
                      onArchive={() => setArchivingChannel(channel)}
                      onDelete={() => setDeletingChannel(channel)}
                      onLeave={() => setLeavingChannel(channel)}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
          )
        )}
      </div>

      <CreateChannelDialog open={isCreateOpen} onClose={() => setIsCreateOpen(false)} />

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
    </div>
  );
}
