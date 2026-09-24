import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import { calculateTaskProgress, calculateCompletedTaskCount } from '@/lib/tasks/progress';
import styles from './Home.module.css';

interface Stats {
  tasks: number;
  completedTasks: number;
  projects: number;
  channels: number;
  members: number;
}

export function Home() {
  const navigate = useNavigate();
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const [stats, setStats] = useState<Stats>({ tasks: 0, completedTasks: 0, projects: 0, channels: 0, members: 0 });
  const [recentTasks, setRecentTasks] = useState<Array<{ id: string; title: string; status: string; priority: string }>>([]);
  const [allTasks, setAllTasks] = useState<Array<{ status: string; status_order: string[] | null }>>([]);
  const [customStatusNames, setCustomStatusNames] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!currentWorkspace?.id || !userId) return;

    let cancelled = false;

    async function load() {
      setIsLoading(true);

      const [tasksRes, projectsRes, channelsRes, membersRes] = await Promise.all([
        supabase.from('tasks').select('id, title, status, priority, status_order').eq('workspace_id', currentWorkspace!.id).is('archived_at', null).order('updated_at', { ascending: false }),
        supabase.from('projects').select('id').eq('workspace_id', currentWorkspace!.id).is('archived_at', null),
        supabase.from('channels').select('id').eq('workspace_id', currentWorkspace!.id),
        supabase.from('workspace_members').select('*', { count: 'exact', head: true }).eq('workspace_id', currentWorkspace!.id),
      ]);

      if (cancelled) return;

      const tasks = (tasksRes.data || []) as Array<{ id: string; title: string; status: string; priority: string; status_order: string[] | null }>;
      const completed = calculateCompletedTaskCount(tasks);

      setStats({
        tasks: tasks.length,
        completedTasks: completed,
        projects: (projectsRes.data || []).length,
        channels: (channelsRes.data || []).length,
        members: (membersRes.count || 0),
      });

      setRecentTasks(tasks.slice(0, 5));
      setAllTasks(tasks.map((t) => ({ status: t.status, status_order: t.status_order })));

      const taskIds = tasks.map((t) => t.id);
      if (taskIds.length > 0) {
        const { data: csData } = await supabase
          .from('task_custom_statuses' as any)
          .select('id, name')
          .in('task_id', taskIds);
        if (csData) {
          const nameMap: Record<string, string> = {};
          for (const cs of csData as any[]) nameMap[cs.id] = cs.name;
          setCustomStatusNames(nameMap);
        }
      }

      setIsLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [currentWorkspace?.id, userId]);

  const progress = calculateTaskProgress(allTasks);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.greeting}>Welcome back</h1>
        <p className={styles.subgreeting}>Here&apos;s what&apos;s happening in <strong>{currentWorkspace?.name || 'your workspace'}</strong></p>
      </div>

      {isLoading ? (
        <div className={styles.statsGrid}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={styles.statCard}>
              <div className={styles.statSkeleton} />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className={styles.statsGrid}>
            <div className={styles.statCard} onClick={() => navigate('/tasks')}>
              <div className={styles.statIcon} style={{ backgroundColor: 'rgba(99, 102, 241, 0.1)', color: '#6366f1' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                </svg>
              </div>
              <div className={styles.statInfo}>
                <span className={styles.statValue}>{stats.tasks}</span>
                <span className={styles.statLabel}>Total Tasks</span>
              </div>
              {stats.tasks > 0 && (
                <div className={styles.miniProgress}>
                  <div className={styles.miniProgressFill} style={{ width: `${progress}%` }} />
                </div>
              )}
            </div>

            <div className={styles.statCard} onClick={() => navigate('/projects')}>
              <div className={styles.statIcon} style={{ backgroundColor: 'rgba(16, 185, 129, 0.1)', color: '#10b981' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
              </div>
              <div className={styles.statInfo}>
                <span className={styles.statValue}>{stats.projects}</span>
                <span className={styles.statLabel}>Projects</span>
              </div>
            </div>

            <div className={styles.statCard} onClick={() => navigate('/channels')}>
              <div className={styles.statIcon} style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div className={styles.statInfo}>
                <span className={styles.statValue}>{stats.channels}</span>
                <span className={styles.statLabel}>Channels</span>
              </div>
            </div>

            <div className={styles.statCard}>
              <div className={styles.statIcon} style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
              <div className={styles.statInfo}>
                <span className={styles.statValue}>{stats.members}</span>
                <span className={styles.statLabel}>Members</span>
              </div>
            </div>
          </div>

          <div className={styles.contentGrid}>
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>Recent Tasks</h3>
                <button type="button" className={styles.cardLink} onClick={() => navigate('/tasks')}>View all</button>
              </div>
              {recentTasks.length === 0 ? (
                <p className={styles.emptyText}>No tasks yet. Create one to get started.</p>
              ) : (
                <div className={styles.taskList}>
                  {recentTasks.map((task) => (
                    <div key={task.id} className={styles.taskRow} onClick={() => navigate('/tasks')}>
                      <span
                        className={styles.taskDot}
                        style={{
                          backgroundColor:
                            task.status === 'completed' ? '#10b981'
                            : task.priority === 'urgent' ? '#ef4444'
                            : task.priority === 'high' ? '#f59e0b'
                            : '#6366f1',
                        }}
                      />
                      <span className={styles.taskTitle}>{task.title}</span>
                      <span className={styles.taskStatus}>{customStatusNames[task.status] ?? task.status.replace('_', ' ')}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>Quick Actions</h3>
              </div>
              <div className={styles.actions}>
                <button type="button" className={styles.actionButton} onClick={() => navigate('/tasks')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  New Task
                </button>
                <button type="button" className={styles.actionButton} onClick={() => navigate('/projects')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  New Project
                </button>
                <button type="button" className={styles.actionButton} onClick={() => navigate('/channels')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  Go to Channels
                </button>
                <button type="button" className={styles.actionButton} onClick={() => navigate('/calendar')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  Calendar
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
