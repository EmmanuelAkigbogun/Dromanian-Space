import { useMemo } from 'react';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import type { Workspace, WorkspaceRole } from '@/types';

interface UseWorkspaceReturn {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  currentRole: WorkspaceRole | null;
  isLoading: boolean;
  error: string | null;
  hasWorkspaces: boolean;
  workspaceSkipped: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  switchWorkspace: (slug: string) => Promise<void>;
  createWorkspace: (name: string, slug: string, description?: string) => Promise<Workspace | null>;
  updateWorkspace: (workspaceId: string, updates: Partial<Pick<Workspace, 'name' | 'description' | 'avatar_url'>>) => Promise<void>;
  deleteWorkspace: (workspaceId: string) => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  skipWorkspace: () => void;
  clearError: () => void;
}

export function useWorkspace(): UseWorkspaceReturn {
  const ctx = useWorkspaceContext();

  const hasWorkspaces = ctx.workspaces.length > 0;
  const isOwner = ctx.currentRole === 'owner';
  const isAdmin = ctx.currentRole === 'owner' || ctx.currentRole === 'admin';

  return useMemo(
    () => ({
      workspaces: ctx.workspaces,
      currentWorkspace: ctx.currentWorkspace,
      currentRole: ctx.currentRole,
      isLoading: ctx.isLoading,
      error: ctx.error,
      hasWorkspaces,
      workspaceSkipped: ctx.workspaceSkipped,
      isOwner,
      isAdmin,
      switchWorkspace: ctx.switchWorkspace,
      createWorkspace: ctx.createWorkspace,
      updateWorkspace: ctx.updateWorkspace,
      deleteWorkspace: ctx.deleteWorkspace,
      refreshWorkspaces: ctx.refreshWorkspaces,
      skipWorkspace: ctx.skipWorkspace,
      clearError: ctx.clearError,
    }),
    [ctx, hasWorkspaces, isOwner, isAdmin],
  );
}
