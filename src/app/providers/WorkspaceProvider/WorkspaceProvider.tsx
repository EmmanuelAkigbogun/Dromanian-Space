import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import {
  getUserWorkspaces,
  getWorkspaceBySlug,
  getWorkspaceMembers,
  createWorkspace as createWorkspaceService,
  updateWorkspace as updateWorkspaceService,
  deleteWorkspace as deleteWorkspaceService,
} from '@/lib/workspace';
import { createChannel as createChannelService } from '@/lib/channel';
import type { Workspace, WorkspaceRole } from '@/types';

interface WorkspaceContextValue {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  currentRole: WorkspaceRole | null;
  isLoading: boolean;
  error: string | null;
  hasWorkspaces: boolean;
  workspaceSkipped: boolean;
  switchWorkspace: (slug: string) => Promise<void>;
  createWorkspace: (name: string, slug: string, description?: string) => Promise<Workspace | null>;
  updateWorkspace: (workspaceId: string, updates: Partial<Pick<Workspace, 'name' | 'description' | 'avatar_url'>>) => Promise<void>;
  deleteWorkspace: (workspaceId: string) => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  skipWorkspace: () => void;
  clearError: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const STORAGE_KEY = 'dark-space-workspace';

function getStoredSlug(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeSlug(slug: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, slug);
  } catch {
    // localStorage not available
  }
}

function clearStoredSlug(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage not available
  }
}

interface WorkspaceProviderProps {
  children: ReactNode;
}

export function WorkspaceProvider({ children }: WorkspaceProviderProps) {
  const { userId, isAuthenticated } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [currentRole, setCurrentRole] = useState<WorkspaceRole | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspaceSkipped, setWorkspaceSkipped] = useState(false);

  const hasWorkspaces = workspaces.length > 0;

  const clearError = useCallback(() => setError(null), []);

  const skipWorkspace = useCallback(() => {
    setWorkspaceSkipped(true);
  }, []);

  const fetchWorkspaces = useCallback(async () => {
    if (!userId || !isAuthenticated) {
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const userWorkspaces = await getUserWorkspaces(userId);
      setWorkspaces(userWorkspaces);

      if (userWorkspaces.length === 0) {
        setCurrentWorkspace(null);
        setCurrentRole(null);
        clearStoredSlug();
        setIsLoading(false);
        return;
      }

      const storedSlug = getStoredSlug();
      let selectedWorkspace: Workspace | undefined;

      if (storedSlug) {
        selectedWorkspace = userWorkspaces.find((w) => w.slug === storedSlug);
      }

      if (!selectedWorkspace) {
        selectedWorkspace = userWorkspaces[0];
      }

      setCurrentWorkspace(selectedWorkspace);
      storeSlug(selectedWorkspace.slug);

      const members = await getWorkspaceMembers(selectedWorkspace.id);
      const membership = members.find((m) => m.user_id === userId);
      setCurrentRole(membership ? (membership.role as WorkspaceRole) : null);
    } catch (err) {
      setError('Failed to load workspaces');
      setCurrentWorkspace(null);
      setCurrentRole(null);
    } finally {
      setIsLoading(false);
    }
  }, [userId, isAuthenticated]);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  // Realtime: re-fetch workspaces when the current user's membership changes
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel('workspace-members-realtime')
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'workspace_members',
        },
        () => {
          // Always refresh on DELETE — payload.old may not include user_id
          // without REPLICA IDENTITY FULL, and member removals are infrequent
          fetchWorkspaces();
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'workspace_members',
        },
        (payload) => {
          // If the current user was added to a new workspace, refresh
          if (payload.new && (payload.new as Record<string, unknown>).user_id === userId) {
            fetchWorkspaces();
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, fetchWorkspaces]);

  const switchWorkspace = useCallback(async (slug: string) => {
    setError(null);
    const workspace = await getWorkspaceBySlug(slug);
    if (!workspace) {
      setError('Workspace not found');
      return;
    }
    setWorkspaces((prev) => prev.map((w) => (w.id === workspace.id ? workspace : w)));
    setCurrentWorkspace(workspace);
    storeSlug(slug);

    if (userId) {
      const members = await getWorkspaceMembers(workspace.id);
      const membership = members.find((m) => m.user_id === userId);
      setCurrentRole(membership ? (membership.role as WorkspaceRole) : null);
    }
  }, [userId]);

  const createWorkspace = useCallback(
    async (name: string, slug: string, description?: string): Promise<Workspace | null> => {
      if (!userId) return null;

      setError(null);
      const workspace = await createWorkspaceService(name, slug, userId, description);
      if (!workspace) {
        setError('Failed to create workspace');
        return null;
      }

      await createChannelService(workspace.id, 'general', 'general', userId, {
        description: 'General discussion for the team.',
      });

      setWorkspaces((prev) => [...prev, workspace]);
      setCurrentWorkspace(workspace);
      setCurrentRole('owner');
      storeSlug(workspace.slug);
      return workspace;
    },
    [userId],
  );

  const updateWorkspace = useCallback(
    async (workspaceId: string, updates: Partial<Pick<Workspace, 'name' | 'description' | 'avatar_url'>>) => {
      setError(null);
      const updated = await updateWorkspaceService(workspaceId, updates);
      if (!updated) {
        setError('Failed to update workspace');
        return;
      }

      setWorkspaces((prev) =>
        prev.map((w) => (w.id === workspaceId ? updated : w)),
      );
      if (currentWorkspace?.id === workspaceId) {
        setCurrentWorkspace(updated);
      }
    },
    [currentWorkspace],
  );

  const deleteWorkspace = useCallback(
    async (workspaceId: string) => {
      setError(null);
      const success = await deleteWorkspaceService(workspaceId);
      if (!success) {
        setError('Failed to delete workspace');
        return;
      }

      let remaining: Workspace[] = [];
      setWorkspaces((prev) => {
        remaining = prev.filter((w) => w.id !== workspaceId);
        return remaining;
      });

      if (currentWorkspace?.id === workspaceId) {
        if (remaining.length > 0) {
          setCurrentWorkspace(remaining[0]);
          storeSlug(remaining[0].slug);
        } else {
          setCurrentWorkspace(null);
          setCurrentRole(null);
          clearStoredSlug();
        }
      }
    },
    [currentWorkspace],
  );

  const refreshWorkspaces = useCallback(async () => {
    await fetchWorkspaces();
  }, [fetchWorkspaces]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaces,
      currentWorkspace,
      currentRole,
      isLoading,
      error,
      hasWorkspaces,
      workspaceSkipped,
      switchWorkspace,
      createWorkspace,
      updateWorkspace,
      deleteWorkspace,
      refreshWorkspaces,
      skipWorkspace,
      clearError,
    }),
    [
      workspaces,
      currentWorkspace,
      currentRole,
      isLoading,
      error,
      hasWorkspaces,
      workspaceSkipped,
      switchWorkspace,
      createWorkspace,
      updateWorkspace,
      deleteWorkspace,
      refreshWorkspaces,
      skipWorkspace,
      clearError,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspaceContext must be used within a WorkspaceProvider');
  }
  return context;
}
