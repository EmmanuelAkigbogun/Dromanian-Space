import { useState, useEffect, useCallback } from 'react';
import { useTasks } from '@/hooks/useTasks';
import { supabase } from '@/lib/supabase';
import { formatRelativeTime } from '@/utils';
import type { TaskActivity as TaskActivityType, TaskAction } from '@/types/task';
import type { Profile } from '@/types';
import styles from './TaskActivity.module.css';

interface TaskActivityProps {
  taskId: string;
}

function getActionIcon(action: TaskAction): string {
  switch (action) {
    case 'created': return 'M12 5v14M5 12h14';
    case 'status_changed': return 'M9 11l3 3L22 4';
    case 'assigned':
    case 'unassigned': return 'M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2';
    case 'completed': return 'M22 11.08V12a10 10 0 11-5.93-9.14';
    case 'priority_changed': return 'M12 2L2 7l10 5 10-5-10-5z';
    case 'edited': return 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7';
    case 'commented': return 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z';
    case 'label_added':
    case 'label_removed': return 'M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z';
    default: return 'M12 2v20M2 12h20';
  }
}

function getActionColor(action: TaskAction): string {
  switch (action) {
    case 'created': return 'var(--color-success)';
    case 'completed': return 'var(--color-success)';
    case 'status_changed': return 'var(--color-info)';
    case 'assigned': return '#8B5CF6';
    case 'unassigned': return 'var(--color-warning)';
    case 'priority_changed': return 'var(--color-warning)';
    case 'edited': return 'var(--color-text-muted)';
    case 'commented': return 'var(--color-info)';
    case 'label_added': return 'var(--color-primary)';
    case 'label_removed': return 'var(--color-error)';
    default: return 'var(--color-text-muted)';
  }
}

export function TaskActivity({ taskId }: TaskActivityProps) {
  const { getTaskActivity } = useTasks();
  const [activities, setActivities] = useState<TaskActivityType[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});

  useEffect(() => {
    const load = async () => {
      const data = await getTaskActivity(taskId);
      setActivities(data);

      const userIds = [
        ...new Set(
          data.flatMap((a) => {
            const ids = [a.user_id];
            if (a.action === 'assigned' || a.action === 'unassigned') {
              if (a.new_value) ids.push(a.new_value);
              if (a.old_value) ids.push(a.old_value);
            }
            return ids;
          }),
        ),
      ];
      if (userIds.length > 0) {
        const { data: profileData } = await supabase
          .from('profiles' as any)
          .select('*')
          .in('id', userIds);

        if (profileData) {
          const map: Record<string, Profile> = {};
          for (const p of profileData as unknown as Profile[]) {
            map[p.id] = p;
          }
          setProfiles(map);
        }
      }
    };

    load();
  }, [taskId, getTaskActivity]);

  if (activities.length === 0) {
    return (
      <div className={styles.container}>
        <p className={styles.emptyState}>No activity yet</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.timeline}>
        {activities.map((activity) => {
          const profile = profiles[activity.user_id];
          const color = getActionColor(activity.action);
          const iconPath = getActionIcon(activity.action);
          const valueId =
            activity.action === 'assigned'
              ? activity.new_value
              : activity.action === 'unassigned'
                ? activity.old_value
                : null;
          const valueProfile = valueId ? profiles[valueId] : undefined;

          return (
            <div key={activity.id} className={styles.entry}>
              <div className={styles.entryLine}>
                <div
                  className={styles.entryIcon}
                  style={{ backgroundColor: `${color}20`, color }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d={iconPath} />
                  </svg>
                </div>
                <div className={styles.entryConnector} />
              </div>

              <div className={styles.entryContent}>
                <div className={styles.entryDescription}>
                  <span className={styles.entryUser}>
                    {profile?.display_name ?? profile?.username ?? 'Unknown'}
                  </span>{' '}
                  {activity.description}
                  {valueId && (
                    <span
                      className={styles.entryValue}
                      style={{ backgroundColor: `${color}18`, color }}
                    >
                      {valueProfile?.display_name ?? valueProfile?.username ?? 'Unknown'}
                    </span>
                  )}
                </div>
                <div className={styles.entryTime}>
                  {formatRelativeTime(activity.created_at)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
