// Parts of the app owners and admins can hide from the rest of the team
// (Settings → Features). Admins always see everything. Hidden AI is also
// refused by the server; the others are hidden from navigation and pages.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/hooks/useWorkspace';
import { platform } from '@/lib/platform';

export type Feature = 'ai' | 'crm' | 'drive' | 'calendar' | 'projects' | 'automation';

export const FEATURES: Array<{ key: Feature; label: string; description: string }> = [
  {
    key: 'ai',
    label: 'AI agents',
    description: 'The Agents tab, Ask AI and Take notes in channels, inviting Scribe into direct messages, @agent mentions and the AI team on Home.',
  },
  { key: 'crm', label: 'CRM', description: 'Contacts, companies and deals.' },
  { key: 'drive', label: 'Drive', description: 'Shared files and documents.' },
  { key: 'calendar', label: 'Calendar', description: 'Events, reminders and scheduled messages.' },
  { key: 'projects', label: 'Projects', description: 'Project boards, milestones and members.' },
  { key: 'automation', label: 'Automation', description: 'Workflow rules and automation integrations.' },
];

/** The first path segment that belongs to each feature. */
const ROUTE_FEATURES: Array<[RegExp, Feature]> = [
  [/^\/(agents|ai)(\/|$)/, 'ai'],
  [/^\/crm(\/|$)/, 'crm'],
  [/^\/(drive|files)(\/|$)/, 'drive'],
  [/^\/calendar(\/|$)/, 'calendar'],
  [/^\/projects(\/|$)/, 'projects'],
  [/^\/automation(\/|$)/, 'automation'],
];

export function featureForPath(path: string): Feature | null {
  return ROUTE_FEATURES.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}

const queryKey = (workspaceId: string | undefined) => ['workspace-features', workspaceId];

export function useFeatureAccess() {
  const { currentWorkspace, isAdmin } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const query = useQuery({
    queryKey: queryKey(workspaceId),
    enabled: !!workspaceId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await platform
        .from<{ hidden: string[] } | null>('workspace_member_features')
        .select('hidden')
        .eq('workspace_id', workspaceId!)
        .maybeSingle();
      return (data?.hidden ?? []) as Feature[];
    },
  });
  const hidden = query.data ?? [];
  return {
    loading: query.isPending && !!workspaceId,
    hidden,
    isAdmin,
    /** Whether the current person can use a feature. */
    canSee: (feature: Feature) => isAdmin || !hidden.includes(feature),
    /** Whether a path belongs to a feature hidden from the current person. */
    pathHidden: (path: string) => {
      const feature = featureForPath(path);
      return !!feature && !isAdmin && hidden.includes(feature);
    },
  };
}

export function useSaveFeatures() {
  const { currentWorkspace } = useWorkspace();
  const client = useQueryClient();
  return async (hidden: Feature[]) => {
    const { error } = await platform.rpc('set_member_features', { p_workspace_id: currentWorkspace!.id, p_hidden: hidden });
    if (error) throw new Error(error.message);
    await client.invalidateQueries({ queryKey: queryKey(currentWorkspace!.id) });
  };
}
