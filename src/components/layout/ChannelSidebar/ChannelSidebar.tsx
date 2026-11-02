import { useState, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useChannel } from '@/hooks/useChannel';
import { useDmDisplayNames } from '@/hooks/useDmDisplayNames';
import styles from './ChannelSidebar.module.css';
import { Floating } from '@/lib/overlay/Floating';

interface ChannelSidebarProps {
  collapsed?: boolean;
}

export function ChannelSidebar({ collapsed = false }: ChannelSidebarProps) {
  const { channels, hasChannels } = useChannel();
  const dmDisplayNames = useDmDisplayNames();
  const navigate = useNavigate();
  const params = useParams();
  const [isOpen, setIsOpen] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const activeSlug = params.slug;

  if (!hasChannels) return null;

  function handleToggle() {
    setIsOpen(!isOpen);
  }

  function handleChannelClick(slug: string) {
    navigate(`/channels/${slug}`);
    setIsOpen(false);
  }

  const displayName = (channel: (typeof channels)[number]) =>
    dmDisplayNames[channel.id] ?? channel.name;

  if (collapsed) {
    return (
      <div className={styles.collapsedSection} ref={dropdownRef}>
        <button
          ref={triggerRef}
          className={styles.collapsedTrigger}
          onClick={handleToggle}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          title="Channels"
          type="button"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>

        <Floating open={isOpen} anchor={triggerRef} placement="right-start" offset={4} onDismiss={() => setIsOpen(false)} className={styles.dropdown} role="listbox">
            <div className={styles.sectionLabel}>Channels</div>
            {channels.map((channel) => {
              const isActive = channel.slug === activeSlug;
              return (
                <button
                  key={channel.id}
                  className={`${styles.option} ${isActive ? styles.optionActive : ''}`}
                  onClick={() => handleChannelClick(channel.slug)}
                  role="option"
                  aria-selected={isActive}
                  type="button"
                >
                  {channel.is_private ? (
                    <svg className={styles.optionIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0110 0v4" />
                    </svg>
                  ) : (
                    <span className={styles.optionHash}>#</span>
                  )}
                  <span className={styles.optionName}>{displayName(channel)}</span>
                </button>
              );
            })}
        </Floating>
      </div>
    );
  }

  // Expanded mode lists channels inline, like the direct-message section below it.
  return (
    <div className={styles.section}>
      <button
        className={styles.sectionHeader}
        onClick={() => setListCollapsed((value) => !value)}
        aria-expanded={!listCollapsed}
        type="button"
      >
        <svg
          className={`${styles.chevron} ${listCollapsed ? styles.chevronCollapsed : ''}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className={styles.sectionTitle}>Channels</span>
        <span className={styles.triggerCount}>{channels.length}</span>
      </button>

      {!listCollapsed && (
        <div className={styles.list}>
            {channels.map((channel) => {
              const isActive = channel.slug === activeSlug;
              return (
                <button
                  key={channel.id}
                  className={`${styles.option} ${isActive ? styles.optionActive : ''}`}
                  onClick={() => handleChannelClick(channel.slug)}
                  role="option"
                  aria-selected={isActive}
                  type="button"
                >
                  {channel.is_private ? (
                    <svg className={styles.optionIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0110 0v4" />
                    </svg>
                  ) : (
                    <span className={styles.optionHash}>#</span>
                  )}
                  <span className={styles.optionName}>{displayName(channel)}</span>
              </button>
            );
          })}
          <button className={`${styles.option} ${styles.optionMuted}`} onClick={() => navigate('/channels')} type="button">
            <span className={styles.optionHash} aria-hidden="true">+</span>
            <span className={styles.optionName}>Browse channels</span>
          </button>
        </div>
      )}
    </div>
  );
}
