import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { Spinner } from '@/components/ui/Spinner';
import { Badge } from '@/components/ui/Badge';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { ProjectBoard } from '@/components/projects/ProjectBoard';
import { ProjectListView } from '@/components/projects/ProjectListView';
import { ProjectMilestones } from '@/components/projects/ProjectMilestones';
import { ProjectMembers } from '@/components/projects/ProjectMembers';
import { ProjectSettings } from '@/components/projects/ProjectSettings';
import { ProjectResources } from '@/components/projects/ProjectResources';
import { TaskDetail } from '@/components/tasks/TaskDetail';
import { useTasks } from '@/hooks/useTasks';
import type { Project, ProjectColumn, ProjectStats, Task, ProjectMemberRole } from '@/types';
import { calculateTaskProgress, calculateCompletedTaskCount } from '@/lib/tasks/progress';
import styles from './ProjectDetail.module.css';

interface ProjectDetailProps {
  projectId: string;
}

export function ProjectDetail({ projectId }: ProjectDetailProps) {
  const navigate = useNavigate();
  const { userId } = useAuth();
  const { currentRole: workspaceRole } = useWorkspace();
  const [searchParams] = useSearchParams();
  const [project, setProject] = useState<Project | null>(null);
  const [columns, setColumns] = useState<ProjectColumn[]>([]);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<ProjectMemberRole | null>(null);
  const { updateTaskStatus, updateTask, deleteTask, archiveTask, restoreTask, duplicateTask } = useTasks();
  const [customStatusesVersion, setCustomStatusesVersion] = useState(0);
  const [taskVersion, setTaskVersion] = useState(0);
  const [statsVersion, setStatsVersion] = useState(0);

  const isWorkspaceAdmin = workspaceRole === 'owner' || workspaceRole === 'admin';
  const canManage = currentUserRole === 'owner' || currentUserRole === 'admin' || isWorkspaceAdmin;
  const canEdit = currentUserRole === 'owner' || currentUserRole === 'admin' || currentUserRole === 'member';
  const canCreate = currentUserRole === 'owner' || currentUserRole === 'admin' || currentUserRole === 'member';
  const canAccessSettings =
    canEdit ||
    workspaceRole === 'owner' ||
    workspaceRole === 'admin' ||
    workspaceRole === 'member';
  const rawTab = searchParams.get('tab');
  const initialTab = rawTab === 'settings' && canAccessSettings ? 'settings' : 'board';

  const handleCustomStatusesChange = useCallback(() => {
    setCustomStatusesVersion((v) => v + 1);
  }, []);

  const handleTaskUpdated = useCallback((updated: Task) => {
    setSelectedTask(updated);
    setTaskVersion((v) => v + 1);
  }, []);

  const fetchProjectData = useCallback(async () => {
    try {
      setIsLoading(true);

      const [projRes, colRes] = await Promise.all([
        supabase.from('projects').select('*').eq('id', projectId).maybeSingle(),
        supabase.from('project_columns').select('*').eq('project_id', projectId).order('sort_order'),
      ]);

      if (projRes.error) throw projRes.error;
      if (!projRes.data) {
        setNotFound(true);
        return;
      }
      const proj = projRes.data as unknown as Project;
      setProject(proj);
      setColumns(colRes.data || []);

      if (userId) {
        const { data: memberRow } = await supabase
          .from('project_members')
          .select('role')
          .eq('project_id', projectId)
          .eq('user_id', userId)
          .maybeSingle();
        const role = (memberRow?.role as ProjectMemberRole) ?? null;
        setCurrentUserRole(role ?? (proj.visibility === 'workspace' ? 'viewer' : null));
      }
    } catch {
      navigate('/projects');
    } finally {
      setIsLoading(false);
    }
  }, [projectId, navigate, userId]);

  const fetchStats = useCallback(async () => {
    const [tasksRes, membersRes] = await Promise.all([
      supabase.from('tasks').select('id, status, due_date, status_order').eq('project_id', projectId).is('archived_at', null),
      supabase.rpc('get_project_member_count', { p_project_id: projectId }),
    ]);

    const taskList = (tasksRes.data || []) as { status: string; due_date: string | null; status_order: string[] | null }[];
    setStats({
      total_tasks: taskList.length,
      completed_tasks: calculateCompletedTaskCount(taskList),
      overdue_tasks: taskList.filter((t) => t.due_date && new Date(t.due_date) < new Date() && t.status !== 'completed').length,
      total_members: membersRes.data || 0,
      progress: calculateTaskProgress(taskList),
    });
  }, [projectId]);

  useEffect(() => {
    fetchProjectData();
  }, [fetchProjectData]);

  useEffect(() => {
    if (!projectId) return;
    fetchStats();
  }, [fetchStats, projectId, statsVersion, taskVersion]);

  useEffect(() => {
    if (!projectId) return;
    const channel = supabase
      .channel(`project-detail-tasks-${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projectId}` },
        () => setStatsVersion((v) => v + 1),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !userId) return;
    const refreshRole = async () => {
      const { data } = await supabase
        .from('project_members')
        .select('role')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .maybeSingle();
      const role = (data?.role as ProjectMemberRole) ?? null;
      setCurrentUserRole(role ?? (project?.visibility === 'workspace' ? 'viewer' : null));
    };
    const channel = supabase
      .channel(`project-detail-members-${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'project_members', filter: `project_id=eq.${projectId}` },
        refreshRole,
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, userId, project?.visibility]);

  const handleProjectUpdate = useCallback((updates: Partial<Project>) => {
    setProject((prev) => prev ? { ...prev, ...updates } : prev);
  }, []);

  const handleStatsChange = useCallback((newStats: ProjectStats) => {
    setStats((prev) => ({
      ...newStats,
      total_members: prev?.total_members ?? newStats.total_members,
    }));
  }, []);

  const handleColumnsChange = useCallback((newColumns: ProjectColumn[]) => {
    setColumns(newColumns);
  }, []);

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <Spinner size="lg" label="Loading project..." />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className={styles.notFound}>
        <div className={styles.notFoundCard}>
          <div className={styles.notFoundIcon}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
          </div>
          <h2 className={styles.notFoundTitle}>Project not found</h2>
          <p className={styles.notFoundText}>
            This project doesn&apos;t exist anymore or you no longer have access to it.
          </p>
          <button type="button" className={styles.notFoundButton} onClick={() => navigate('/projects')}>
            Back to Projects
          </button>
        </div>
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button type="button" className={styles.backButton} onClick={() => navigate('/projects')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <div
            className={styles.iconCircle}
            style={{ backgroundColor: project.color || 'var(--color-surface-secondary)' }}
          >
            <span className={styles.icon}>
              {project.icon || project.name.charAt(0).toUpperCase()}
            </span>
          </div>
          <div className={styles.headerInfo}>
            <h1 className={styles.title}>
              {project.name}
              {currentUserRole && (
                <Badge variant={currentUserRole === 'viewer' ? 'default' : 'primary'} size="sm" className={styles.roleBadge}>
                  {currentUserRole.charAt(0).toUpperCase() + currentUserRole.slice(1)}
                </Badge>
              )}
            </h1>
            {project.description && (
              <p className={styles.description}>{project.description}</p>
            )}
            <div className={styles.headerMeta}>
              <span className={styles.metaItem}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                </svg>
                {stats?.total_members || 0} members
              </span>
              <span className={styles.metaItem}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                </svg>
                {stats?.total_tasks || 0} tasks
              </span>
            </div>
          </div>
        </div>
      </div>

      {stats && (
        <div className={styles.statsRow}>
          <div className={styles.statCard}>
            <span className={styles.statValue}>{stats.total_tasks}</span>
            <span className={styles.statLabel}>Total Tasks</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statValue}>{stats.completed_tasks}</span>
            <span className={styles.statLabel}>Completed</span>
          </div>
          <div className={styles.statCard}>
            <span className={`${styles.statValue} ${stats.overdue_tasks > 0 ? styles.overdueValue : ''}`}>
              {stats.overdue_tasks}
            </span>
            <span className={styles.statLabel}>Overdue</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statValue}>{stats.progress}%</span>
            <span className={styles.statLabel}>Progress</span>
          </div>
        </div>
      )}

      <Tabs defaultTab={initialTab} key={initialTab}>
        <TabsList>
          <TabsTrigger id="board">Board</TabsTrigger>
          <TabsTrigger id="list">List</TabsTrigger>
          <TabsTrigger id="milestones">Milestones</TabsTrigger>
          <TabsTrigger id="resources">Resources</TabsTrigger>
          <TabsTrigger id="members">Members</TabsTrigger>
          {canAccessSettings && <TabsTrigger id="settings">Settings</TabsTrigger>}
        </TabsList>

        <TabsContent id="board">
          <div className={styles.tabPanel}>
            <ProjectBoard
              projectId={projectId}
              workspaceId={project.workspace_id}
              columns={columns}
              onColumnsChange={handleColumnsChange}
              onTaskClick={setSelectedTask}
              onTaskUpdated={() => setStatsVersion((v) => v + 1)}
              onTaskDuplicate={duplicateTask}
              customStatusesVersion={customStatusesVersion}
              taskVersion={taskVersion}
              canEdit={canEdit}
              canCreate={canCreate}
            />
          </div>
        </TabsContent>

        <TabsContent id="list">
          <div className={styles.tabPanel}>
            <ProjectListView projectId={projectId} workspaceId={project.workspace_id} columns={columns} onStatsChange={handleStatsChange} onTaskDuplicate={duplicateTask} customStatusesVersion={customStatusesVersion} taskVersion={taskVersion} canEdit={canEdit} canCreate={canCreate} />
          </div>
        </TabsContent>

        <TabsContent id="milestones">
          <div className={styles.tabPanel}>
            <ProjectMilestones projectId={projectId} canEdit={canEdit} canCreate={canCreate} />
          </div>
        </TabsContent>

        <TabsContent id="resources">
          <div className={styles.tabPanel}>
            <ProjectResources projectId={projectId} canManage={canManage} />
          </div>
        </TabsContent>

        <TabsContent id="members">
          <div className={styles.tabPanel}>
            <ProjectMembers projectId={projectId} canManage={canManage} />
          </div>
        </TabsContent>

        {canAccessSettings && (
          <TabsContent id="settings">
            <div className={styles.tabPanel}>
              <ProjectSettings
                project={project}
                onUpdate={handleProjectUpdate}
                canManage={canManage}
                onArchive={async () => {
                  const { error } = await supabase.from('projects').update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', projectId);
                  if (!error) {
                    navigate('/projects');
                  }
                }}
                onDelete={async () => {
                  await supabase.from('projects').delete().eq('id', projectId);
                  navigate('/projects');
                }}
              />
            </div>
          </TabsContent>
        )}
      </Tabs>

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onUpdate={updateTask}
          onDelete={async (id) => {
            const ok = await deleteTask(id);
            if (ok) setTaskVersion((v) => v + 1);
            return ok;
          }}
          onArchive={async (id) => {
            const ok = await archiveTask(id);
            if (ok) setTaskVersion((v) => v + 1);
            return ok;
          }}
          onRestore={async (id) => {
            const ok = await restoreTask(id);
            if (ok) setTaskVersion((v) => v + 1);
            return ok;
          }}
          onStatusChange={updateTaskStatus}
          onCustomStatusesChange={handleCustomStatusesChange}
          onTaskUpdated={handleTaskUpdated}
          customStatuses={columns}
          canEdit={canEdit || selectedTask.created_by === userId}
        />
      )}
    </div>
  );
}
