import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Avatar } from '@/components/ui/Avatar';
import { useWorkspace } from '@/hooks/useWorkspace';
import { getAuditLog, describeAuditAction, type AuditLogEntry } from '@/lib/workspace/settings';
import styles from './WorkspaceAuditLog.module.css';

export function WorkspaceAuditLog() {
  const { currentWorkspace } = useWorkspace();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    if (!currentWorkspace) return;
    setIsLoading(true);
    try {
      const data = await getAuditLog(currentWorkspace.id);
      setEntries(data);
    } finally {
      setIsLoading(false);
    }
  }, [currentWorkspace]);

  useEffect(() => {
    load();
  }, [load]);

  if (!currentWorkspace) return null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <p className={styles.text}>
          Record of member, channel, and message changes in this workspace.
        </p>
        <Button variant="secondary" size="sm" onClick={load}>
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className={styles.loading}>
          <Spinner size="sm" />
        </div>
      ) : entries.length === 0 ? (
        <div className={styles.empty}>
          <span>No activity recorded yet.</span>
        </div>
      ) : (
        <ul className={styles.list}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.row}>
              <Avatar
                src={entry.actor_avatar ?? undefined}
                name={entry.actor_name ?? 'System'}
                size="sm"
              />
              <div className={styles.details}>
                <span className={styles.action}>
                  {describeAuditAction(entry.action)}
                </span>
                <span className={styles.actor}>
                  by {entry.actor_name ?? 'System'}
                  {entry.entity_type ? ` · ${entry.entity_type}` : ''}
                </span>
              </div>
              <span className={styles.time}>
                {new Date(entry.created_at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
