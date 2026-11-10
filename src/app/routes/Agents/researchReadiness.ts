const CORE_RESEARCH_AGENTS = new Set([
  'cerebras_coordinator',
  'cerebras_research',
  'agno_scout',
  'github_seo_specialist',
  'github_competitor_intelligence',
]);

const PUBLIC_RESEARCH_TOOLS = new Set(['web_search', 'browser_scrape', 'fetch_site_page']);

export interface ResearchToolStatus {
  name: string;
  available: boolean;
  reason?: string;
}
/**
 * Returns a user-facing limitation only when public research is a core part of
 * the role and none of the role's assigned public-research tools can run.
 */
export function coreResearchLimitation(
  templateKey: string,
  assignedTools: readonly string[],
  statuses: readonly ResearchToolStatus[],
): string | null {
  if (!CORE_RESEARCH_AGENTS.has(templateKey)) return null;
  const assigned = assignedTools.filter((name) => PUBLIC_RESEARCH_TOOLS.has(name));
  if (assigned.length === 0) return 'Public research tools are not assigned to this research role.';

  const statusByName = new Map(statuses.map((status) => [status.name, status]));
  if (assigned.some((name) => statusByName.get(name)?.available === true)) return null;

  const reasons = Array.from(new Set(
    assigned
      .map((name) => statusByName.get(name)?.reason)
      .filter((reason): reason is string => Boolean(reason)),
  ));
  return reasons[0]
    ? `Public research is unavailable: ${reasons[0]}`
    : 'Public research is currently unavailable for this role.';
}
