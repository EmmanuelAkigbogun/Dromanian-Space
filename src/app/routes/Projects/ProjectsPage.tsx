import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '@/hooks/useProjects';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useToast } from '@/components/ui/Toast';
import { ProjectList } from '@/components/projects/ProjectList';
import { ProjectDialog } from '@/components/projects/ProjectDialog';
import type { Project } from '@/types';
import styles from './ProjectsPage.module.css';

export function ProjectsPage() {
  const navigate = useNavigate();
  const { currentWorkspace } = useWorkspace();
  const { toast } = useToast();
  const {
    projects,
    isLoading,
    createProject,
    archiveProject,
    refetch,
  } = useProjects();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [filter, setFilter] = useState<'active' | 'archived'>('active');
  const [searchQuery, setSearchQuery] = useState('');
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([]);
  const [isLoadingArchived, setIsLoadingArchived] = useState(false);

  const fetchArchived = useCallback(async () => {
    if (!currentWorkspace?.id) return;
    setIsLoadingArchived(true);
    const { supabase } = await import('@/lib/supabase');
    const { data } = await supabase
      .from('projects')
      .select('*')
      .eq('workspace_id', currentWorkspace.id)
      .not('archived_at', 'is', null)
      .order('archived_at', { ascending: false });
    setArchivedProjects((data || []) as unknown as Project[]);
    setIsLoadingArchived(false);
  }, [currentWorkspace?.id]);

  const handleFilterChange = useCallback((newFilter: 'active' | 'archived') => {
    setFilter(newFilter);
    if (newFilter === 'archived' && archivedProjects.length === 0) {
      fetchArchived();
    }
  }, [archivedProjects.length, fetchArchived]);

  const handleCreateProject = useCallback(async (data: {
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    visibility?: import('@/types').ProjectVisibility;
    due_date?: string;
  }) => {
    const result = await createProject(data);
    if (result) {
      toast({ description: 'Project created', variant: 'success' });
      return true;
    }
    return false;
  }, [createProject, toast]);

  const handleProjectClick = useCallback((project: Project) => {
    navigate(`/projects/${project.id}`);
  }, [navigate]);

  const handleProjectSettings = useCallback((project: Project) => {
    navigate(`/projects/${project.id}?tab=settings`);
  }, [navigate]);

  const handleRestoreProject = useCallback(async (projectId: string) => {
    const { supabase } = await import('@/lib/supabase');
    const { error } = await supabase
      .from('projects')
      .update({ archived_at: null, updated_at: new Date().toISOString() })
      .eq('id', projectId);

    if (error) {
      toast({ description: 'Failed to restore project', variant: 'error' });
      return;
    }

    toast({ description: 'Project restored', variant: 'success' });
    setArchivedProjects((prev) => prev.filter((p) => p.id !== projectId));
    refetch();
  }, [refetch, toast]);

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div className={styles.pageHeaderRow}>
          <div>
            <h2 className={styles.pageTitle}>Projects</h2>
            <p className={styles.pageDescription}>Manage your team's projects and track progress.</p>
          </div>
          <button
            type="button"
            className={styles.createButton}
            onClick={() => setIsCreateOpen(true)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Create project
          </button>
        </div>
      </div>

      <div className={styles.searchBar}>
        <div className={styles.searchInputWrapper}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={styles.searchIcon}>
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button type="button" className={styles.clearBtn} onClick={() => setSearchQuery('')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className={styles.pageContent}>
        <ProjectList
          projects={projects}
          archivedProjects={archivedProjects}
          isLoading={isLoading || isLoadingArchived}
          filter={filter}
          onFilterChange={handleFilterChange}
          onProjectClick={handleProjectClick}
          onCreateProject={() => setIsCreateOpen(true)}
          onRestoreProject={handleRestoreProject}
          onSettings={handleProjectSettings}
          searchQuery={searchQuery}
        />
      </div>

      <ProjectDialog
        open={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSave={handleCreateProject}
      />
    </div>
  );
}
