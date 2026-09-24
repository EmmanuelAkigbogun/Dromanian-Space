import { memo, useCallback, useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConversation } from '@/hooks/useConversation';
import { useAuth } from '@/hooks/useAuth';
import { usePresenceContext } from '@/app/providers/PresenceProvider';
import { Avatar } from '@/components/ui/Avatar';
import { Dialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/Spinner';
import { StartDmDialog } from '@/components/dm/StartDmDialog';
import { CreateGroupDialog } from '@/components/dm/CreateGroupDialog';
import { getDisplayName } from '@/lib/message';
import { getProfile } from '@/lib/profile';
import { getPresenceLabel, presenceToAvatarStatus } from '@/lib/presence';
import type { ConversationWithParticipants } from '@/lib/conversation';
import type { Profile } from '@/types';
import styles from './DmSidebar.module.css';

interface DmSidebarProps {
  isCollapsed: boolean;
}

export const DmSidebar = memo(function DmSidebar({ isCollapsed }: DmSidebarProps) {
  const navigate = useNavigate();
  const { conversations, currentConversation, hasConversations } = useConversation();
  const { userId } = useAuth();
  const { presenceMap } = usePresenceContext();
  const [isExpanded, setIsExpanded] = useState(true);
  const [showStartDm, setShowStartDm] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!selectedUserId) { setSelectedProfile(null); return; }
    let cancelled = false;
    setProfileLoading(true);
    getProfile(selectedUserId).then((p) => {
      if (!cancelled) { setSelectedProfile(p); setProfileLoading(false); }
    });
    return () => { cancelled = true; };
  }, [selectedUserId]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCollapsedToggle = useCallback(() => {
    if (!isDropdownOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.left });
    }
    setIsDropdownOpen((prev) => !prev);
  }, [isDropdownOpen]);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const getOtherParticipant = useCallback(
    (conv: ConversationWithParticipants): Profile | null => {
      if (conv.type === 'dm') {
        const other = conv.participants.find((p) => p.user_id !== userId);
        if (other) return other.profile ?? null;
        const self = conv.participants.find((p) => p.user_id === userId);
        return self?.profile ?? null;
      }
      return null;
    },
    [userId],
  );

  const getConversationName = useCallback(
    (conv: ConversationWithParticipants): string => {
      if (conv.name) return conv.name;
      const other = getOtherParticipant(conv);
      if (other) return getDisplayName(other, other.id);
      return 'Conversation';
    },
    [getOtherParticipant],
  );

  const getConversationAvatar = useCallback(
    (conv: ConversationWithParticipants): string | null => {
      if (conv.avatar_url) return conv.avatar_url;
      const other = getOtherParticipant(conv);
      return other?.avatar_url ?? null;
    },
    [getOtherParticipant],
  );

  const handleConversationClick = useCallback(
    (conv: ConversationWithParticipants) => {
      navigate(`/dm/${conv.id}`);
    },
    [navigate],
  );

  if (isCollapsed) {
    return (
      <div className={styles.collapsedSection} ref={dropdownRef}>
        <button
          ref={triggerRef}
          className={styles.collapsedTrigger}
          onClick={handleCollapsedToggle}
          aria-expanded={isDropdownOpen}
          aria-haspopup="listbox"
          title="Direct Messages"
          type="button"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>

        {isDropdownOpen && dropdownPos && (
          <div className={styles.dropdown} role="listbox" style={{ top: dropdownPos.top, left: dropdownPos.left, position: 'fixed' }}>
            <div className={styles.sectionLabel}>Direct Messages</div>
            <div className={styles.buttonRow}>
              <button type="button" className={styles.newMessageButton} onClick={() => { setShowStartDm(true); setIsDropdownOpen(false); }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                New
              </button>
              <button type="button" className={styles.groupButton} onClick={() => { setShowCreateGroup(true); setIsDropdownOpen(false); }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                Group
              </button>
            </div>
            {!hasConversations ? (
              <div className={styles.empty}>No conversations yet</div>
            ) : (
              conversations.map((conv) => {
                const isActive = currentConversation?.id === conv.id;
                const name = getConversationName(conv);
                const avatar = getConversationAvatar(conv);
                const isGroup = conv.type === 'group';
                const other = isGroup ? null : getOtherParticipant(conv);

                return (
                  <button
                    key={conv.id}
                    type="button"
                    className={`${styles.option} ${isActive ? styles.optionActive : ''}`}
                    onClick={() => { handleConversationClick(conv); setIsDropdownOpen(false); }}
                    role="option"
                    aria-selected={isActive}
                  >
                    {isGroup ? (
                      <div className={styles.groupAvatarSmall}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                          <circle cx="9" cy="7" r="4" />
                        </svg>
                      </div>
                    ) : (
                      <Avatar src={avatar ?? undefined} name={name} size="sm" status={other && presenceMap.get(other.id)?.status === 'online' ? 'online' : null} />
                    )}
                    <span className={styles.optionName}>{name}</span>
                  </button>
                );
              })
            )}
          </div>
        )}

        <StartDmDialog open={showStartDm} onClose={() => setShowStartDm(false)} />
        <CreateGroupDialog open={showCreateGroup} onClose={() => setShowCreateGroup(false)} />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <button type="button" className={styles.header} onClick={handleToggle}>
        <svg
          className={`${styles.chevron} ${isExpanded ? styles.chevronExpanded : ''}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span className={styles.label}>Direct Messages</span>
      </button>

      {isExpanded && (
        <div className={styles.list}>
          <div className={styles.buttonRow}>
            <button
              type="button"
              className={styles.newMessageButton}
              onClick={() => setShowStartDm(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New
            </button>
            <button
              type="button"
              className={styles.groupButton}
              onClick={() => setShowCreateGroup(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              Group
            </button>
          </div>

          {!hasConversations ? (
            <div className={styles.empty}>No conversations yet</div>
          ) : (
            conversations.map((conv) => {
              const isActive = currentConversation?.id === conv.id;
              const name = getConversationName(conv);
              const avatar = getConversationAvatar(conv);
              const isGroup = conv.type === 'group';
              const participantCount = conv.participants.length;
              const other = isGroup ? null : getOtherParticipant(conv);

              return (
                <button
                  key={conv.id}
                  type="button"
                  className={`${styles.conversationItem} ${isActive ? styles.conversationActive : ''}`}
                  onClick={() => handleConversationClick(conv)}
                >
                  <div className={styles.avatarWrapper} onClick={(e) => {
                    e.stopPropagation();
                    if (other) setSelectedUserId(other.id);
                  }} style={{ cursor: isGroup ? undefined : 'pointer' }}>
                    {isGroup ? (
                      <div className={styles.groupAvatar}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                          <circle cx="9" cy="7" r="4" />
                          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                        </svg>
                      </div>
                    ) : (
                      <Avatar src={avatar ?? undefined} name={name} size="sm" status={other && presenceMap.get(other.id)?.status === 'online' ? 'online' : null} />
                    )}
                  </div>
                  <div className={styles.conversationInfo}>
                    <span className={styles.conversationName}>{name}</span>
                    {isGroup && (
                      <span className={styles.memberCount}>{participantCount} members</span>
                    )}
                    {conv.lastMessage && (
                      <span className={styles.lastMessage}>
                        {conv.lastMessage.content.length > 40
                          ? conv.lastMessage.content.slice(0, 40) + '...'
                          : conv.lastMessage.content}
                      </span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}

      <StartDmDialog open={showStartDm} onClose={() => setShowStartDm(false)} />
      <CreateGroupDialog open={showCreateGroup} onClose={() => setShowCreateGroup(false)} />

      <Dialog open={!!selectedUserId} onClose={() => setSelectedUserId(null)} title="Profile" size="sm">
        {profileLoading ? (
          <div className={styles.profileLoading}>
            <Spinner size="sm" />
          </div>
        ) : selectedProfile ? (
          <div className={styles.profileDialog}>
            <Avatar
              src={selectedProfile.avatar_url ?? undefined}
              name={selectedProfile.display_name || selectedProfile.username || selectedProfile.email}
              size="lg"
              status={presenceToAvatarStatus(selectedUserId ? presenceMap.get(selectedUserId)?.status : 'offline')}
            />
            <span className={styles.profileName}>
              {selectedProfile.display_name || selectedProfile.username || 'Unknown'}
            </span>
            {selectedProfile.username && selectedProfile.display_name && (
              <span className={styles.profileUsername}>@{selectedProfile.username}</span>
            )}
            {selectedProfile.bio && (
              <p className={styles.profileBio}>{selectedProfile.bio}</p>
            )}
            <span className={styles.profileStatus}>
              {getPresenceLabel(selectedUserId ? presenceMap.get(selectedUserId)?.status : 'offline')}
            </span>
            {selectedProfile.timezone && (
              <span className={styles.profileLocalTime}>
                Local time ·{' '}
                {new Date().toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                  timeZone: selectedProfile.timezone,
                })}
              </span>
            )}
          </div>
        ) : (
          <p className={styles.profileNotFound}>Profile not found</p>
        )}
      </Dialog>
    </div>
  );
});
