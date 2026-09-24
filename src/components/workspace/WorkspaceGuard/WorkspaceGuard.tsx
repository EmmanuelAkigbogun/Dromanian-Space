import { useWorkspace } from '@/hooks/useWorkspace';
import { WorkspaceLoading } from '../WorkspaceLoading';
import { EmptyWorkspace } from '../EmptyWorkspace';
import { WorkspaceError } from '../WorkspaceError';

interface WorkspaceGuardProps {
  children: React.ReactNode;
}

export function WorkspaceGuard({ children }: WorkspaceGuardProps) {
  const { currentWorkspace, isLoading, error, hasWorkspaces, workspaceSkipped, skipWorkspace } = useWorkspace();

  if (isLoading) {
    return <WorkspaceLoading />;
  }

  if (error) {
    return <WorkspaceError message={error} />;
  }

  if (!hasWorkspaces && !workspaceSkipped) {
    return <EmptyWorkspace onSkip={skipWorkspace} />;
  }

  if (!currentWorkspace && !workspaceSkipped) {
    return <WorkspaceError message="No workspace selected" />;
  }

  return <>{children}</>;
}
