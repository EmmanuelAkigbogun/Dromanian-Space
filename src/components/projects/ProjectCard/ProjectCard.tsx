import { useState, useEffect } from 'react';
import { Progress } from '@/components/ui/Progress';
import { Avatar } from '@/components/ui/Avatar';
import { supabase } from '@/lib/supabase';
import { calculateTaskProgress, calculateCompletedTaskCount } from '@/lib/tasks/progress';
import { truncate } from '@/utils';
import type { Project } from '@/types';
import styles from './ProjectCard.module.css';

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
  onSettings?: () => void;
  onRestore?: () => void;
  isArchived?: boolean;
}

interface ProjectCardStats {
  totalTasks: number;
  completedTasks: number;
  tasks: Array<{ status: string; status_order: string[] | null }>;
  members: Array<{ user_id: string; display_name: string | null; avatar_url: string | null }>;
}

export function ProjectCard({ project, onClick, onSettings, onRestore, isArchived }: ProjectCardProps) {
  const [stats, setStats] = useState<ProjectCardStats>({ totalTasks: 0, completedTasks: 0, tasks: [], members: [] });

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      const [tasksRes, membersRes] = await Promise.all([
        supabase
          .from('tasks')
          .select('id, status, status_order')
          .eq('project_id', project.id)
          .is('archived_at', null),
        supabase
          .rpc('get_project_members', { p_project_id: project.id })
          .limit(5),
      ]);

      if (cancelled) return;

      const tasks = (tasksRes.data || []) as { status: string; status_order: string[] | null }[];
      const memberRows = (membersRes.data || []) as { user_id: string; display_name: string | null; avatar_url: string | null }[];
      const members = memberRows.map((m) => ({
        user_id: m.user_id,
        display_name: m.display_name ?? null,
        avatar_url: m.avatar_url ?? null,
      }));

      setStats({
        totalTasks: tasks.length,
        completedTasks: calculateCompletedTaskCount(tasks),
        tasks,
        members,
      });
    }

    loadStats();
    return () => { cancelled = true; };
  }, [project.id]);

  const progress = calculateTaskProgress(stats.tasks);

  const isOverdue = project.due_date
    ? new Date(project.due_date) < new Date()
    : false;

  return (
    <div
      className={styles.card}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      role="button"
      tabIndex={0}
    >
      <div className={styles.header}>
        <div
          className={styles.iconCircle}
          style={{ backgroundColor: project.color || 'var(--color-surface-secondary)' }}
        >
          <span className={styles.icon}>
            {project.icon || project.name.charAt(0).toUpperCase()}
          </span>
        </div>
        <div className={styles.headerInfo}>
          <h3 className={styles.name}>{project.name}</h3>
          {project.description && (
            <p className={styles.description}>{truncate(project.description, 80)}</p>
          )}
        </div>
        {!isArchived && (
          <button
            type="button"
            className={styles.settingsButton}
            onClick={(e) => { e.stopPropagation(); onSettings?.(); }}
            title="Project settings"
            aria-label={`${project.name} settings`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
      </div>

      <div className={styles.body}>
        <div className={styles.statsRow}>
          <span className={styles.statLabel}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
            {stats.completedTasks}/{stats.totalTasks} tasks
          </span>
          <span className={styles.progressValue}>{progress}%</span>
        </div>
        <Progress value={progress} size="sm" />

        <div className={styles.footer}>
          {isArchived ? (
            <button
              type="button"
              className={styles.restoreButton}
              onClick={(e) => { e.stopPropagation(); onRestore?.(); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              Restore
            </button>
          ) : (
            <>
              <div className={styles.members}>
                {stats.members.map((m) => (
                  <div key={m.user_id} className={styles.avatarWrap}>
                    <Avatar
                      src={m.avatar_url || undefined}
                      name={m.display_name || 'Member'}
                      size="xs"
                    />
                  </div>
                ))}
              </div>
              {project.due_date && (
                <span className={`${styles.dueDate} ${isOverdue ? styles.overdue : ''}`}>
                  {new Date(project.due_date).toLocaleDateString()}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
