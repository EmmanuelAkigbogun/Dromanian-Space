import { Badge } from '@/components/ui/Badge/Badge';
import { Switch } from '@/components/ui/Switch/Switch';
import { formatRelativeTime } from '@/utils';
import type { AutomationRule } from '@/types';
import styles from './AutomationRuleCard.module.css';

interface AutomationRuleCardProps {
  rule: AutomationRule;
  canManage?: boolean;
  canRequestEdit?: boolean;
  onRequestEdit?: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (rule: AutomationRule) => void;
  onDuplicate: (rule: AutomationRule) => void;
  onDelete: (id: string) => void;
  onExport: (rule: AutomationRule) => void;
}

const TRIGGER_LABELS: Record<string, string> = {
  'task.created': 'Task Created',
  'task.completed': 'Task Completed',
  'task.status_changed': 'Status Changed',
  'task.assigned': 'Task Assigned',
  'message.posted': 'Message Posted',
  'project.created': 'Project Created',
  'project.archived': 'Project Archived',
  'member.joined': 'Member Joined',
  'member.left': 'Member Left',
  'calendar.event_created': 'Event Created',
  'calendar.event_reminder': 'Event Reminder',
  'calendar.event_started': 'Event Started',
};

export function AutomationRuleCard({ rule, canManage = true, canRequestEdit = false, onRequestEdit, onToggle, onEdit, onDuplicate, onDelete, onExport }: AutomationRuleCardProps) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.cardInfo}>
          <span className={styles.cardTitle}>{rule.name}</span>
          {rule.description && (
            <span className={styles.cardDescription}>{rule.description}</span>
          )}
        </div>
        <Switch
          checked={rule.enabled}
          onChange={(e) => onToggle(rule.id, e.target.checked)}
          label=""
          disabled={!canManage}
        />
      </div>

      <div className={styles.cardBody}>
        <div className={styles.triggersSection}>
          <span className={styles.label}>Triggers</span>
          <div className={styles.badgeList}>
            {(rule.triggers ?? []).map((trigger, index) => (
              <Badge key={index} variant="primary" size="sm">
                {TRIGGER_LABELS[trigger.event_type] || trigger.event_type}
              </Badge>
            ))}
          </div>
        </div>

        <div className={styles.statsRow}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Conditions</span>
            <span className={styles.statValue}>{(rule.conditions ?? []).length}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Actions</span>
            <span className={styles.statValue}>{(rule.actions ?? []).length}</span>
          </div>
          {rule.last_executed_at && (
            <div className={styles.stat}>
              <span className={styles.statLabel}>Last run</span>
              <span className={styles.statValue}>{formatRelativeTime(rule.last_executed_at)}</span>
            </div>
          )}
        </div>
      </div>

      <div className={styles.cardFooter}>
        {canManage ? (
          <button
            type="button"
            className={styles.editButton}
            onClick={() => onEdit(rule)}
            title="Edit rule"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit
          </button>
        ) : canRequestEdit ? (
          <button
            type="button"
            className={styles.requestButton}
            onClick={() => onRequestEdit?.()}
            title="Ask the owner for edit access"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Request edit
          </button>
        ) : (
          <span className={styles.pendingLabel}>Edit requested</span>
        )}
        <div className={styles.footerActions}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => onExport(rule)}
            title="Export rule"
            aria-label="Export rule"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 3v12m0 0l-4-4m4 4l4-4" />
              <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => onDuplicate(rule)}
            title="Duplicate rule"
            aria-label="Duplicate rule"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.iconButtonDanger}`}
            onClick={() => onDelete(rule.id)}
            disabled={!canManage}
            title={canManage ? 'Delete rule' : 'Only the owner or a workspace admin can delete this rule'}
            aria-label="Delete rule"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
