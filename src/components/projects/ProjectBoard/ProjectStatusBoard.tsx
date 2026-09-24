import { useState, useCallback } from 'react';
import { Progress } from '@/components/ui/Progress';
import { Spinner } from '@/components/ui/Spinner';
import { supabase } from '@/lib/supabase';
import { calculateTaskProgress, calculateCompletedTaskCount } from '@/lib/tasks/progress';
import { truncate } from '@/utils';
import type { Project } from '@/types';
import styles from './ProjectBoard.module.css';

type ProjectStatus = 'planning' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled';

interface ProjectStatusBoardProps {
  projects: Project[];
  isLoading: boolean;
  onProjectClick: (project: Project) => void;
  onStatusChange?: (projectId: string, status: string) => void;
  searchQuery?: string;
}

const PROJECT_COLUMNS: { status: ProjectStatus; label: string; color: string }[] = [
  { status: 'planning', label: 'Planning', color: '#6b7280' },
  { status: 'in_progress', label: 'In Progress', color: '#3b82f6' },
  { status: 'on_hold', label: 'On Hold', color: '#f59e0b' },
  { status: 'completed', label: 'Completed', color: '#10b981' },
  { status: 'cancelled', label: 'Cancelled', color: '#ef4444' },
];

interface ProjectBoardCardProps {
  project: Project;
  onClick: () => void;
}

function ProjectBoardCard({ project, onClick }: ProjectBoardCardProps) {
  const [stats, setStats] = useState<{ total: number; completed: number; tasks: Array<{ status: string; status_order: string[] | null }> }>({ total: 0, completed: 0, tasks: [] });

  useState(() => {
    let cancelled = false;
    supabase
      .from('tasks')
      .select('id, status, status_order')
      .eq('project_id', project.id)
      .is('archived_at', null)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const tasks = (data as any[]).map((t) => ({ status: t.status, status_order: t.status_order }));
        setStats({
          total: data.length,
          completed: calculateCompletedTaskCount(tasks),
          tasks,
        });
      });
    return () => { cancelled = true; };
  });

  const progress = calculateTaskProgress(stats.tasks);
  const isOverdue = project.due_date && new Date(project.due_date) < new Date();

  return (
    <div
      className={styles.projectCard}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      role="button"
      tabIndex={0}
    >
      <div className={styles.cardHeader}>
        <div
          className={styles.iconCircle}
          style={{ backgroundColor: project.color || 'var(--color-surface-secondary)' }}
        >
          <span className={styles.icon}>
            {project.icon || project.name.charAt(0).toUpperCase()}
          </span>
        </div>
        <h4 className={styles.projectName}>{project.name}</h4>
      </div>

      {project.description && (
        <p className={styles.projectDesc}>{truncate(project.description, 80)}</p>
      )}

      <div className={styles.cardStats}>
        <span className={styles.statText}>
          {stats.completed}/{stats.total} tasks
        </span>
        <span className={styles.statText}>{progress}%</span>
      </div>
      <Progress value={progress} size="sm" />

      <div className={styles.cardFooter}>
        {project.due_date && (
          <span className={`${styles.dueDate} ${isOverdue ? styles.overdue : ''}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            {new Date(project.due_date).toLocaleDateString()}
          </span>
        )}
        <span className={styles.visibilityBadge}>{project.visibility}</span>
      </div>
    </div>
  );
}

export function ProjectStatusBoard({
  projects,
  isLoading,
  onProjectClick,
  onStatusChange,
  searchQuery = '',
}: ProjectStatusBoardProps) {
  const [draggedProject, setDraggedProject] = useState<Project | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const filteredProjects = searchQuery.trim()
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (p.description && p.description.toLowerCase().includes(searchQuery.toLowerCase())),
      )
    : projects;

  const projectsByStatus = PROJECT_COLUMNS.reduce<Record<ProjectStatus, Project[]>>(
    (acc, { status }) => {
      acc[status] = filteredProjects.filter((p) => (p.status || 'planning') === status);
      return acc;
    },
    { planning: [], in_progress: [], on_hold: [], completed: [], cancelled: [] },
  );

  const handleDragStart = useCallback((e: React.DragEvent, project: Project) => {
    setDraggedProject(project);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', project.id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, status: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(status);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, targetStatus: string) => {
      e.preventDefault();
      setDragOverColumn(null);

      if (!draggedProject || (draggedProject.status || 'planning') === targetStatus) {
        setDraggedProject(null);
        return;
      }

      if (onStatusChange) {
        onStatusChange(draggedProject.id, targetStatus);
      }

      await supabase
        .from('projects')
        .update({ status: targetStatus, updated_at: new Date().toISOString() })
        .eq('id', draggedProject.id);

      setDraggedProject(null);
    },
    [draggedProject, onStatusChange],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedProject(null);
    setDragOverColumn(null);
  }, []);

  if (isLoading) {
    return (
      <div className={styles.loadingState}>
        <Spinner size="lg" label="Loading projects..." />
      </div>
    );
  }

  return (
    <div className={styles.board}>
      {PROJECT_COLUMNS.map(({ status, label, color }) => {
        const columnProjects = projectsByStatus[status];
        const isDragOver = dragOverColumn === status;

        return (
          <div
            key={status}
            className={styles.column}
            onDragOver={(e) => handleDragOver(e, status)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, status)}
          >
            <div className={styles.columnHeader}>
              <div className={styles.columnTitle}>
                <span className={styles.columnDot} style={{ backgroundColor: color }} />
                {label}
                <span className={styles.columnCount}>{columnProjects.length}</span>
              </div>
            </div>

            <div className={`${styles.columnBody} ${isDragOver ? styles.dragOver : ''}`}>
              {columnProjects.length === 0 ? (
                <div className={styles.columnBodyEmpty}>No projects</div>
              ) : (
                columnProjects.map((project) => (
                  <div
                    key={project.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, project)}
                    onDragEnd={handleDragEnd}
                  >
                    <ProjectBoardCard
                      project={project}
                      onClick={() => onProjectClick(project)}
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
