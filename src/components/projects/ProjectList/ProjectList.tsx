import { useState, useMemo } from 'react';
import { ProjectCard } from '@/components/projects/ProjectCard';
import { Spinner } from '@/components/ui/Spinner';
import type { Project } from '@/types';
import styles from './ProjectList.module.css';

type FilterType = 'active' | 'archived';

interface ProjectListProps {
  projects: Project[];
  archivedProjects: Project[];
  isLoading: boolean;
  filter: FilterType;
  onFilterChange: (filter: FilterType) => void;
  onProjectClick: (project: Project) => void;
  onCreateProject: () => void;
  onRestoreProject?: (projectId: string) => void;
  onSettings?: (project: Project) => void;
  searchQuery: string;
}

export function ProjectList({
  projects,
  archivedProjects,
  isLoading,
  filter,
  onFilterChange,
  onProjectClick,
  onCreateProject,
  onRestoreProject,
  onSettings,
  searchQuery,
}: ProjectListProps) {
  const filteredProjects = useMemo(() => {
    const list = filter === 'active' ? projects : archivedProjects;
    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)),
    );
  }, [projects, archivedProjects, filter, searchQuery]);

  if (isLoading) {
    return (
      <div className={styles.loadingContainer}>
        <Spinner size="lg" label="Loading projects..." />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.tabs}>
        <button
          type="button"
          className={`${styles.tab} ${filter === 'active' ? styles.tabActive : ''}`}
          onClick={() => onFilterChange('active')}
        >
          Active
          {projects.length > 0 && <span className={styles.tabCount}>{projects.length}</span>}
        </button>
        <button
          type="button"
          className={`${styles.tab} ${filter === 'archived' ? styles.tabActive : ''}`}
          onClick={() => onFilterChange('archived')}
        >
          Archived
          {archivedProjects.length > 0 && <span className={styles.tabCount}>{archivedProjects.length}</span>}
        </button>
      </div>

      {filteredProjects.length === 0 ? (
        <div className={styles.emptyState}>
          {filter === 'archived' ? (
            <>
              <div className={styles.emptyIcon}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M21 8v13H3V8" />
                  <path d="M1 3h22v5H1z" />
                  <path d="M10 12h4" />
                </svg>
              </div>
              <p className={styles.emptyText}>No archived projects</p>
            </>
          ) : (
            <>
              <div className={styles.emptyIcon}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                </svg>
              </div>
              <p className={styles.emptyText}>No projects yet</p>
              <p className={styles.emptyDescription}>Create your first project to get started.</p>
              <button type="button" className={styles.createButton} onClick={onCreateProject}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Create project
              </button>
            </>
          )}
        </div>
      ) : (
        <div className={styles.grid}>
          {filteredProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onClick={() => onProjectClick(project)}
              onSettings={onSettings ? () => onSettings(project) : undefined}
              isArchived={filter === 'archived'}
              onRestore={onRestoreProject ? () => onRestoreProject(project.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
