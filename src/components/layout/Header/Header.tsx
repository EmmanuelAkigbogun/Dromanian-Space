import { useNavigate } from 'react-router-dom';
import { useLayout } from '@/app/providers/LayoutProvider';
import { useProfileContext } from '@/app/providers/ProfileProvider';
import { isEmojiAvatarUrl } from '@/components/ui/Avatar';
import { ThemeToggle } from '@/components/theme';
import { NotificationBell } from '@/components/notification-center/NotificationBell/NotificationBell';
import { SearchTrigger } from '@/components/search/SearchTrigger/SearchTrigger';
import styles from './Header.module.css';

interface HeaderProps {
  title?: string;
}

export function Header({ title = 'Δαρκ space' }: HeaderProps) {
  const { openMobileSidebar } = useLayout();
  const navigate = useNavigate();
  const { profile } = useProfileContext();

  const avatarUrl = profile?.avatar_url ?? null;
  const name = profile?.display_name || profile?.username || '';
  const initials = name
    ? (() => {
      const parts = name.trim().split(/\s+/);
      return parts.length >= 2
        ? (parts[0][0] + parts[1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();
    })()
    : 'DS';

  return (
    <header className={styles.header} role="banner">
      <div className={styles.headerLeft}>
        <button
          className={styles.headerMenuButton}
          onClick={openMobileSidebar}
          aria-label="Open navigation menu"
          type="button"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        <h1 className={styles.headerTitle}>
          <span className={styles.titleFull}>Δαρκ space</span>
          <span className={styles.titleShort}>Δαρκ ❀</span>
        </h1>
      </div>

      <div className={styles.headerRight}>
        <SearchTrigger />

        <ThemeToggle />

        <NotificationBell />

        <button
          className={`${styles.headerAvatar}${avatarUrl && isEmojiAvatarUrl(avatarUrl) ? ` ${styles.headerAvatarEmoji}` : ''}`}
          aria-label="Go to profile"
          type="button"
          onClick={() => navigate('/profile')}
        >
          {avatarUrl ? (
            isEmojiAvatarUrl(avatarUrl) ? (
              <span className={styles.avatarEmoji}>{avatarUrl}</span>
            ) : (
              <img src={avatarUrl} alt="Profile" className={styles.avatarImage} />
            )
          ) : (
            initials
          )}
        </button>
      </div>
    </header>
  );
}
