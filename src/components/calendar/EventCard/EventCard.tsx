import { Avatar } from '@/components/ui/Avatar/Avatar';
import type { CalendarEvent, EventParticipant } from '@/types';
import styles from './EventCard.module.css';

interface EventCardProps {
  event: CalendarEvent;
  participants?: EventParticipant[];
  onClick?: (event: CalendarEvent) => void;
  compact?: boolean;
  isOverdue?: boolean;
}

const EVENT_COLORS = ['#82A6B1', '#2D8A4E', '#B8860B', '#C43E3E', '#4A7C9B', '#9B59B6'];

export function EventCard({ event, participants = [], onClick, compact = false, isOverdue = false }: EventCardProps) {
  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <button
      type="button"
      className={`${styles.eventCard} ${compact ? styles.compact : ''}`}
      style={{ borderLeftColor: event.color || EVENT_COLORS[0] }}
      onClick={() => onClick?.(event)}
    >
      <div className={styles.content}>
        <span className={styles.title}>{event.title}</span>
        <div className={styles.meta}>
          {event.all_day ? (
            <span className={styles.time}>All Day</span>
          ) : (
            <span className={styles.time}>
              {formatTime(event.start_at)} - {formatTime(event.end_at)}
            </span>
          )}
          {!compact && event.location && (
            <span className={styles.location}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              {event.location}
            </span>
          )}
        </div>
      </div>
      {participants.length > 0 && (
        <div className={styles.participants}>
          {participants.slice(0, 3).map((p) => (
            <Avatar key={p.id} size="xs" name={p.user_id} />
          ))}
          {participants.length > 3 && (
            <span className={styles.moreCount}>+{participants.length - 3}</span>
          )}
        </div>
      )}
      {isOverdue && <span className={styles.overdueBadge}>Overdue</span>}
    </button>
  );
}
