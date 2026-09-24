import type { Message } from '@/types';

const GROUPING_WINDOW_MS = 60 * 1000;

export function isTempId(id: string): boolean {
  return id.startsWith('temp-');
}

export function formatTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return formatTime(dateString);
}

export function getDisplayName(
  profile: { display_name?: string | null; username?: string | null; email?: string } | null,
  userId: string,
): string {
  if (profile?.display_name) return profile.display_name;
  if (profile?.username) return profile.username;
  if (profile?.email) return profile.email.split('@')[0];
  return userId.slice(0, 8);
}

export function shouldGroupWithPrevious(current: Message, previous: Message | undefined): boolean {
  if (!previous) return false;
  if (previous.deleted_at) return false;
  if (current.user_id !== previous.user_id) return false;

  const currentTime = new Date(current.created_at).getTime();
  const previousTime = new Date(previous.created_at).getTime();
  return currentTime - previousTime < GROUPING_WINDOW_MS;
}

export function needsDateSeparator(current: Message, previous: Message | undefined): boolean {
  if (!previous) return true;
  const currentDate = new Date(current.created_at).toDateString();
  const previousDate = new Date(previous.created_at).toDateString();
  return currentDate !== previousDate;
}
