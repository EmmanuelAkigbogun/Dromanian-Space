import { useState, useEffect, type ReactNode, type ReactElement } from 'react';
import { Popover, Trigger, Content } from '@/components/ui/Popover/Popover';
import { Avatar } from '@/components/ui/Avatar/Avatar';
import { Spinner } from '@/components/ui/Spinner/Spinner';
import { getProfile } from '@/lib/profile';
import { getPresenceLabel, presenceToAvatarStatus } from '@/lib/presence';
import { usePresenceContext } from '@/app/providers/PresenceProvider';
import type { Profile } from '@/types';
import styles from './UserProfilePopover.module.css';

interface UserProfilePopoverProps {
  userId: string;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}

export function UserProfilePopover({ userId, children, side = 'top' }: UserProfilePopoverProps) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);
  const { presenceMap } = usePresenceContext();

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoading(true);
    getProfile(userId).then((p) => {
      if (!cancelled) {
        setProfile(p);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [userId]);

  const presenceStatus = presenceMap.get(userId)?.status ?? 'offline';

  return (
    <Popover>
      <Trigger asChild>{children as ReactElement}</Trigger>
      <Content side={side} align="start" sideOffset={8}>
        <div className={styles.popover}>
          {loading ? (
            <div className={styles.loading}>
              <Spinner size="sm" />
            </div>
          ) : profile ? (
            <>
              <div className={styles.header}>
                <Avatar
                  src={profile.avatar_url ?? undefined}
                  name={profile.display_name || profile.username || profile.email}
                  size="lg"
                  status={presenceToAvatarStatus(presenceStatus)}
                />
                <div className={styles.info}>
                  <span className={styles.name}>
                    {profile.display_name || profile.username || 'Unknown'}
                  </span>
                  {profile.username && profile.display_name && (
                    <span className={styles.username}>@{profile.username}</span>
                  )}
                </div>
              </div>
              {profile.bio && (
                <p className={styles.bio}>{profile.bio}</p>
              )}
              <div className={styles.meta}>
                <span className={styles.status}>
                  {getPresenceLabel(presenceStatus)}
                </span>
                {profile.timezone && (
                  <span className={styles.localTime}>
                    Local time ·{' '}
                    {new Date().toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                      timeZone: profile.timezone,
                    })}
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className={styles.notFound}>Profile not found</p>
          )}
        </div>
      </Content>
    </Popover>
  );
}
