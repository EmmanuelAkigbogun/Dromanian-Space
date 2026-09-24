import { Badge } from '@/components/ui/Badge/Badge';
import type { AutomationTrigger } from '@/types';
import styles from './TriggerBuilder.module.css';

interface TriggerBuilderProps {
  triggers: AutomationTrigger[];
  onChange: (triggers: AutomationTrigger[]) => void;
}

interface TriggerCategory {
  name: string;
  events: Array<{ type: string; label: string }>;
}

const TRIGGER_CATEGORIES: TriggerCategory[] = [
  {
    name: 'Workspace',
    events: [
      { type: 'member.joined', label: 'Member Joined' },
      { type: 'member.left', label: 'Member Left' },
    ],
  },
  {
    name: 'Tasks',
    events: [
      { type: 'task.created', label: 'Task Created' },
      { type: 'task.completed', label: 'Task Completed' },
      { type: 'task.status_changed', label: 'Status Changed' },
      { type: 'task.assigned', label: 'Task Assigned' },
    ],
  },
  {
    name: 'Projects',
    events: [
      { type: 'project.created', label: 'Project Created' },
      { type: 'project.archived', label: 'Project Archived' },
    ],
  },
  {
    name: 'Messaging',
    events: [
      { type: 'message.posted', label: 'Message Posted' },
      { type: 'message.mentioned', label: 'Message Mentions Me' },
      { type: 'message.reaction_added', label: 'Message Reacted' },
    ],
  },
  {
    name: 'Calendar',
    events: [
      { type: 'calendar.event_created', label: 'Event Created' },
      { type: 'calendar.event_reminder', label: 'Event Reminder' },
      { type: 'calendar.event_started', label: 'Event Started' },
    ],
  },
];

export function TriggerBuilder({ triggers, onChange }: TriggerBuilderProps) {
  const selectedTypes = triggers.map((t) => t.event_type);

  const toggleTrigger = (eventType: string) => {
    if (selectedTypes.includes(eventType)) {
      onChange(triggers.filter((t) => t.event_type !== eventType));
    } else {
      onChange([...triggers, { event_type: eventType }]);
    }
  };

  return (
    <div className={styles.triggerBuilder}>
      <span className={styles.sectionLabel}>Select Triggers</span>
      <p className={styles.sectionHint}>Choose which events will trigger this automation.</p>

      {selectedTypes.length > 0 && (
        <div className={styles.selectedTriggers}>
          {selectedTypes.map((type) => {
            const category = TRIGGER_CATEGORIES.find((c) => c.events.some((e) => e.type === type));
            const event = category?.events.find((e) => e.type === type);
            return (
              <Badge key={type} variant="primary" size="md" className={styles.selectedBadge}>
                {event?.label || type}
                <button
                  type="button"
                  className={styles.removeBadge}
                  onClick={() => toggleTrigger(type)}
                  aria-label={`Remove ${event?.label || type}`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </Badge>
            );
          })}
        </div>
      )}

      <div className={styles.categories}>
        {TRIGGER_CATEGORIES.map((category) => (
          <div key={category.name} className={styles.category}>
            <span className={styles.categoryName}>{category.name}</span>
            <div className={styles.eventList}>
              {category.events.map((event) => {
                const isSelected = selectedTypes.includes(event.type);
                return (
                  <button
                    key={event.type}
                    type="button"
                    className={`${styles.eventOption} ${isSelected ? styles.eventOptionSelected : ''}`}
                    onClick={() => toggleTrigger(event.type)}
                  >
                    <span className={styles.checkbox}>
                      {isSelected && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    <span className={styles.eventLabel}>{event.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
