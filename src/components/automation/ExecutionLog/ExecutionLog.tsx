import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/ui/Badge/Badge';
import { Select } from '@/components/ui/Select/Select';
import { ScrollArea } from '@/components/ui/ScrollArea/ScrollArea';
import { formatRelativeTime } from '@/utils';
import type { AutomationExecutionLog } from '@/types';
import styles from './ExecutionLog.module.css';

interface ExecutionLogProps {
  fetchLogs: (ruleId?: string) => Promise<AutomationExecutionLog[]>;
  ruleId?: string;
  onDelete?: (logId: string) => void;
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

const PAGE_SIZE = 20;

export function ExecutionLog({ fetchLogs, ruleId, onDelete }: ExecutionLogProps) {
  const [logs, setLogs] = useState<AutomationExecutionLog[]>([]);
  const [filter, setFilter] = useState<'all' | 'success' | 'failure'>('all');
  const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setVisibleCount(PAGE_SIZE);
    const data = await fetchLogs(ruleId);
    setLogs(data);
    setLoading(false);
  }, [fetchLogs, ruleId]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const handleDelete = useCallback(async (logId: string) => {
    await onDelete?.(logId);
    await loadLogs();
  }, [onDelete, loadLogs]);

  const filteredLogs = logs.filter((log) => {
    if (filter === 'success') return log.success;
    if (filter === 'failure') return !log.success;
    return true;
  });
  const visibleLogs = filteredLogs.slice(0, visibleCount);
  const hasMore = filteredLogs.length > visibleCount;

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading execution logs...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Execution History</span>
        <Select
          options={[
            { value: 'all', label: 'All' },
            { value: 'success', label: 'Success' },
            { value: 'failure', label: 'Failed' },
          ]}
          value={filter}
          onChange={(e) => setFilter(e.target.value as 'all' | 'success' | 'failure')}
          className={styles.filterSelect}
        />
      </div>

      {filteredLogs.length === 0 ? (
        <div className={styles.empty}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={styles.emptyIcon}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <span className={styles.emptyText}>No execution logs found</span>
          <span className={styles.emptyHint}>
            {filter !== 'all' ? 'Try changing the filter' : 'Logs will appear after the rule runs'}
          </span>
        </div>
      ) : (
        <>
        <ScrollArea className={styles.logList}>
          {visibleLogs.map((log) => (
            <div key={log.id} className={`${styles.logItem} ${!log.success ? styles.logError : ''}`}>
              <div className={styles.logHeader}>
                <div className={styles.logTrigger}>
                  <Badge variant={log.success ? 'success' : 'error'} size="sm">
                    {TRIGGER_LABELS[log.trigger_event] || log.trigger_event}
                  </Badge>
                </div>
                <div className={styles.logMeta}>
                  <span className={styles.logActions}>
                    {log.actions_executed} action{log.actions_executed !== 1 ? 's' : ''}
                  </span>
                  <Badge
                    variant={log.success ? 'success' : 'error'}
                    size="sm"
                  >
                    {log.success ? 'Success' : 'Failed'}
                  </Badge>
                  {onDelete && (
                    <button
                      type="button"
                      className={styles.deleteButton}
                      onClick={() => handleDelete(log.id)}
                      title="Delete log entry"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              <div className={styles.logDetails}>
                <div className={styles.logDetail}>
                  <span className={styles.detailLabel}>Conditions Met</span>
                  <span className={`${styles.detailValue} ${log.conditions_met ? styles.metTrue : styles.metFalse}`}>
                    {log.conditions_met ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    )}
                    {log.conditions_met ? 'Yes' : 'No'}
                  </span>
                </div>
                <div className={styles.logDetail}>
                  <span className={styles.detailLabel}>Time</span>
                  <span className={styles.detailValue}>{formatRelativeTime(log.executed_at)}</span>
                </div>
              </div>

              {log.error_message && (
                <div className={styles.errorMessage}>
                  <span className={styles.errorLabel}>Error:</span> {log.error_message}
                </div>
              )}
            </div>
          ))}
        </ScrollArea>
        {hasMore && (
          <button
            type="button"
            className={styles.loadMore}
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          >
            Show more logs
          </button>
        )}
        </>
      )}
    </div>
  );
}
