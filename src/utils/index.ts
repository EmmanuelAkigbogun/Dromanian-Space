/**
 * Format a date relative to now
 */
export function formatRelativeTime(date: string | Date): string {
  const now = new Date();
  const then = new Date(date);
  const diffMs = then.getTime() - now.getTime();
  const absDiffMs = Math.abs(diffMs);
  const future = diffMs > 0;
  const diffSeconds = Math.floor(absDiffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return future ? 'in a moment' : 'just now';
  if (diffMinutes < 60) return future ? `in ${diffMinutes}m` : `${diffMinutes}m ago`;
  if (diffHours < 24) return future ? `in ${diffHours}h` : `${diffHours}h ago`;
  if (diffDays < 7) return future ? `in ${diffDays}d` : `${diffDays}d ago`;

  return then.toLocaleDateString();
}

/**
 * Format a date for a datetime-local input in the user's local timezone
 */
export function toLocalDatetimeString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * True when a timestamp is exactly UTC midnight, i.e. stored as an all-day value
 */
export function isAllDayTimestamp(value: string | null | undefined): boolean {
  if (!value) return false;
  const date = new Date(value);
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
}

/**
 * Format a date with its time unless it is an all-day value
 */
export function formatTaskDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (isAllDayTimestamp(value)) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Format a date always including its time
 */
export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Format a date without its time
 */
export function formatDateOnly(value: string): string {
  return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Format file size
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Truncate text
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Get initials from name
 */
export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Clamp a number between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
