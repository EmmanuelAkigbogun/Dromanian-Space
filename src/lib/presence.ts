import type { PresenceStatus } from '@/app/providers/PresenceProvider';

export const PRESENCE_LABELS: Record<PresenceStatus, string> = {
  online: 'Online',
  away: 'Away',
  busy: 'Busy',
  invisible: 'Invisible',
  offline: 'Offline',
};

export function getPresenceLabel(status: PresenceStatus | null | undefined): string {
  return status ? PRESENCE_LABELS[status] : 'Offline';
}

export function presenceToAvatarStatus(status: PresenceStatus | null | undefined): 'online' | 'offline' | 'away' | 'busy' {
  switch (status) {
    case 'online':
      return 'online';
    case 'away':
      return 'away';
    case 'busy':
      return 'busy';
    default:
      return 'offline';
  }
}
