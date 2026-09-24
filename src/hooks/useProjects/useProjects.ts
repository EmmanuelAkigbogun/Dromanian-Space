import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { calculateTaskProgress, calculateCompletedTaskCount } from '@/lib/tasks/progress';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { createTypedNotification } from '@/features/notifications/service';
import type { Project, ProjectStats, ProjectVisibility } from '@/types';

interface CreateProjectParams {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  visibility?: ProjectVisibility;
  due_date?: string;
}

interface UseProjectsReturn {
  projects: Project[];
  isLoading: boolean;
  error: string | null;
  createProject: (params: CreateProjectParams) => Promise<Project | null>;
  updateProject: (projectId: string, updates: Partial<Pick<Project, 'name' | 'description' | 'icon' | 'color' | 'visibility' | 'due_date'>>) => Promise<boolean>;
  updateProjectStatus: (projectId: string, status: string) => Promise<boolean>;
  archiveProject: (projectId: string) => Promise<boolean>;
  deleteProject: (projectId: string) => Promise<boolean>;
  getProjectStats: (projectId: string) => Promise<ProjectStats | null>;
  refetch: () => Promise<void>;
}

export function useProjects(): UseProjectsReturn {
  const { userId } = useAuth();
  const { currentWorkspace, currentRole } = useWorkspace();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const membersChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const fetchProjects = useCallback(async () => {
    if (!currentWorkspace?.id) {
      setProjects([]);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const { data, error: fetchError } = await supabase
        .from('projects')
        .select('*')
        .eq('workspace_id', currentWorkspace.id)
        .is('archived_at', null)
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;

      const allProjects = (data || []) as unknown as Project[];

      const memberProjectIds = allProjects
        .filter((p) => p.owner_id !== userId)
        .map((p) => p.id);

      let memberOfProjectIds = new Set<string>();
      if (memberProjectIds.length > 0) {
        const { data: memberships } = await supabase
          .from('project_members')
          .select('project_id')
          .eq('user_id', userId!)
          .in('project_id', memberProjectIds);
        memberOfProjectIds = new Set(((memberships || []) as any[]).map((m: any) => m.project_id));
      }

      const isWorkspaceAdmin = currentRole === 'owner' || currentRole === 'admin';
      const visibleProjects = allProjects.filter((p) => {
        if (p.owner_id === userId) return true;
        if (p.visibility === 'workspace') return true;
        if (isWorkspaceAdmin) return true;
        return memberOfProjectIds.has(p.id);
      });

      setProjects(visibleProjects);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch projects');
    } finally {
      setIsLoading(false);
    }
  }, [currentWorkspace?.id, userId, currentRole]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    if (!currentWorkspace?.id) return;

    channelRef.current = supabase
      .channel(`projects:${currentWorkspace.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'projects',
          filter: `workspace_id=eq.${currentWorkspace.id}`,
        },
        () => {
          fetchProjects();
        },
      )
      .subscribe();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [currentWorkspace?.id, fetchProjects]);

  useEffect(() => {
    if (!currentWorkspace?.id || !userId) return;

    membersChannelRef.current = supabase
      .channel(`project-members:${currentWorkspace.id}:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_members',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          fetchProjects();
        },
      )
      .subscribe();

    return () => {
      if (membersChannelRef.current) {
        supabase.removeChannel(membersChannelRef.current);
        membersChannelRef.current = null;
      }
    };
  }, [currentWorkspace?.id, userId, fetchProjects]);

  const createProject = useCallback(async (params: CreateProjectParams): Promise<Project | null> => {
    if (!currentWorkspace?.id || !userId) {
      setError('No workspace or user context');
      return null;
    }

    try {
      setError(null);

      const { data: projectData, error: createError } = await supabase
        .from('projects')
        .insert({
          workspace_id: currentWorkspace.id,
          name: params.name,
          description: params.description || null,
          icon: params.icon || null,
          color: params.color || null,
          visibility: params.visibility || 'workspace',
          due_date: params.due_date || null,
          owner_id: userId,
        })
        .select()
        .single();

      if (createError) throw createError;

      const defaultColumns = ['Backlog', 'To Do', 'In Progress', 'Done'];
      const columnInserts = defaultColumns.map((name, index) => ({
        project_id: projectData.id,
        name,
        sort_order: index,
      }));

      const { error: colError } = await supabase
        .from('project_columns')
        .insert(columnInserts);

      if (colError) throw colError;

      const { error: memberError } = await supabase
        .rpc('add_project_member', { p_project_id: projectData.id, p_user_id: userId, p_role: 'owner' });

      if (memberError) throw memberError;

      setProjects((prev) => (prev.some((p) => p.id === projectData.id) ? prev : [projectData as unknown as Project, ...prev]));

      const visibility = params.visibility || 'workspace';
      if (visibility !== 'private') {
        notifyProjectCreated(currentWorkspace.id, userId, projectData.id, params.name, visibility).catch(() => {});
      }

      return projectData as unknown as Project;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
      return null;
    }
  }, [currentWorkspace?.id, userId]);

  const updateProject = useCallback(async (
    projectId: string,
    updates: Partial<Pick<Project, 'name' | 'description' | 'icon' | 'color' | 'visibility'>>,
  ): Promise<boolean> => {
    try {
      setError(null);

      const { error: updateError } = await supabase
        .from('projects')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', projectId);

      if (updateError) throw updateError;

      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, ...updates } : p)),
      );
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update project');
      return false;
    }
  }, []);

  const updateProjectStatus = useCallback(async (projectId: string, status: string): Promise<boolean> => {
    try {
      setError(null);
      const { error } = await supabase
        .from('projects')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', projectId);
      if (error) throw error;
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, status } : p)));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update project status');
      return false;
    }
  }, []);

  const archiveProject = useCallback(async (projectId: string): Promise<boolean> => {
    try {
      setError(null);

      const { error } = await supabase
        .from('projects')
        .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', projectId);

      if (error) throw error;

      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive project');
      return false;
    }
  }, []);

  const deleteProject = useCallback(async (projectId: string): Promise<boolean> => {
    try {
      setError(null);

      const { error } = await supabase
        .from('projects')
        .delete()
        .eq('id', projectId);

      if (error) throw error;

      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete project');
      return false;
    }
  }, []);

  const getProjectStats = useCallback(async (projectId: string): Promise<ProjectStats | null> => {
    try {
      setError(null);

      const { data: tasks, error: taskError } = await supabase
        .from('tasks')
        .select('id, status, due_date, status_order')
        .eq('project_id', projectId)
        .is('archived_at', null);

      if (taskError) throw taskError;

      const { data: memberCount, error: memberError } = await supabase
        .rpc('get_project_member_count', { p_project_id: projectId });

      if (memberError) throw memberError;

      const taskList = (tasks || []) as { id: string; status: string; due_date: string | null; status_order: string[] | null }[];
      const totalTasks = taskList.length;
      const completedTasks = calculateCompletedTaskCount(taskList);
      const now = new Date();
      const overdueTasks = taskList.filter(
        (t) => t.due_date && new Date(t.due_date) < now && t.status !== 'completed',
      ).length;
      const progress = calculateTaskProgress(taskList);

      return {
        total_tasks: totalTasks,
        completed_tasks: completedTasks,
        overdue_tasks: overdueTasks,
        total_members: memberCount || 0,
        progress,
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get project stats');
      return null;
    }
  }, []);

  async function notifyProjectCreated(
    workspaceId: string,
    creatorId: string,
    projectId: string,
    projectName: string,
    visibility: ProjectVisibility,
  ) {
    let recipientIds: string[] = [];

    if (visibility === 'workspace') {
      const { data: members } = await supabase
        .from('workspace_members')
        .select('user_id')
        .eq('workspace_id', workspaceId);
      recipientIds = (members || []).map((m) => m.user_id).filter((id) => id !== creatorId);
    } else if (visibility === 'members') {
      const { data: projectMembers } = await supabase
        .from('project_members')
        .select('user_id')
        .eq('project_id', projectId);
      recipientIds = (projectMembers || []).map((m) => m.user_id).filter((id) => id !== creatorId);
    }

    if (recipientIds.length === 0) return;

    const creatorProfile = await supabase.from('profiles').select('display_name, username').eq('id', creatorId).single();
    const creatorName = creatorProfile.data?.display_name || creatorProfile.data?.username || 'Someone';

    await Promise.allSettled(
      recipientIds.map((recipientId) =>
        createTypedNotification(
          recipientId,
          'system',
          `New project: ${projectName}`,
          `${creatorName} created the project "${projectName}"`,
          `/projects/${projectId}`,
          'projects',
          'project',
          projectId,
          creatorId,
          workspaceId,
        ),
      ),
    );
  }

  return {
    projects,
    isLoading,
    error,
    createProject,
    updateProject,
    updateProjectStatus,
    archiveProject,
    deleteProject,
    getProjectStats,
    refetch: fetchProjects,
  };
}
