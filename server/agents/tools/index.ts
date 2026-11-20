import { z } from 'zod';
import type { ToolSpec } from '../../ai/provider.js';
import { submitTasksForApproval } from './approvals.js';
import { browserScrape } from './browser.js';
import { crmReport, readCrmRecord, proposeCrmUpdate, searchCrm, searchCrmNotes } from './crm.js';
import { computeCsvMetrics } from './csv-metrics.js';
import { listGithubRepos, readGithubRepo } from './github.js';
import { listDrive, proposeDriveAction } from './drive.js';
import { proposeChannelMessage, proposeDocument, proposeSocialPosts, proposeTask } from './propose.js';
import { listTasks, readConversationTool, readFile, searchKnowledge, searchWorkspace } from './read.js';
import {
  delegateToSpecialists, proposeCalendarEvent, readBrandKit, readCalendar, readPersonalNotes, savePersonalNote, workspaceMetrics,
} from './workspace.js';
import type { AgentTool } from './types.js';

/** Client tools the engine implements. web_search and fetch_site_page are provider (server) tools. */
export const TOOL_REGISTRY: Record<string, AgentTool> = Object.fromEntries(
  [
    searchCrm, searchCrmNotes, readCrmRecord, crmReport, proposeCrmUpdate, listDrive, proposeDriveAction, searchWorkspace, searchKnowledge, readFile, readConversationTool, listTasks, computeCsvMetrics,
    proposeTask, proposeDocument, proposeChannelMessage, proposeSocialPosts, readCalendar, proposeCalendarEvent, workspaceMetrics, readBrandKit,
    readPersonalNotes, savePersonalNote, delegateToSpecialists, submitTasksForApproval, browserScrape,
    listGithubRepos, readGithubRepo,
  ].map((t) => [t.name, t as unknown as AgentTool]),
);

/** Tools the model provider runs itself. */
export const PROVIDER_TOOLS = ['web_search', 'fetch_site_page'];

export const KNOWN_TOOLS = [...Object.keys(TOOL_REGISTRY), ...PROVIDER_TOOLS];

/**
 * Tools a run receives beyond its agent's configured list. crm_report only
 * counts the same records search_crm can already list, so it follows CRM
 * search (removing search_crm from an agent removes both); the coordinator
 * gets it to answer simple CRM questions without delegating.
 */
export function companionTools(tools: readonly string[], opts: { coordinator?: boolean } = {}): string[] {
  const out = [...tools];
  if ((tools.includes('search_crm') || opts.coordinator) && !out.includes('crm_report')) out.push('crm_report');
  // GitHub reads only what the requester's own connected accounts can read.
  if (tools.includes('search_workspace') || tools.includes('list_tasks') || opts.coordinator) {
    for (const name of ['list_github_repos', 'read_github_repo']) if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Run guidance that goes with companion tools. */
export const GITHUB_GUIDANCE = 'GitHub: the requester may have GitHub accounts connected in Darkspace. For anything about their repositories, commits, issues or connected accounts, call list_github_repos and read_github_repo; never ask them to paste a repository list. To pair repositories with tasks, read the repository and compare its commits and issues with the project tasks it returns.';

export const CRM_COUNTS_GUIDANCE = 'CRM counts: this workspace has its own built-in CRM; never ask which CRM product or database is used. For any count, total, share or breakdown of CRM records (for example "how many companies have at least one contact"), call crm_report and quote its numbers and the CRM it covers. Never estimate from search_crm listings, which are capped at 50 rows.';

export interface ToolAvailability {
  name: string;
  available: boolean;
  /** Why it is unavailable, in words an admin can act on. */
  reason?: string;
  approval: 'none' | 'review_card' | 'project_manager';
}

const APPROVAL: Record<string, ToolAvailability['approval']> = {
  propose_task: 'review_card',
  propose_document: 'review_card',
  propose_channel_message: 'review_card',
  propose_crm_update: 'review_card',
  propose_calendar_event: 'review_card',
  propose_drive_action: 'review_card',
  propose_social_posts: 'review_card',
  submit_tasks_for_approval: 'project_manager',
};

export interface AvailabilityInputs {
  webResearchEnabled: boolean;
  webResearchAvailable: boolean;
  browserScraperAvailable: boolean;
  browserScraperReason?: string;
  crmInstalled: boolean;
  siteUrl: string | null;
  brandKitFolderId: string | null;
}

export function toolAvailability(names: string[], opts: AvailabilityInputs): ToolAvailability[] {
  return names.map((name) => {
    const approval = APPROVAL[name] ?? 'none';
    if (name === 'browser_scrape') {
      return {
        name,
        available: opts.webResearchEnabled && opts.browserScraperAvailable,
        approval,
        reason: !opts.webResearchEnabled
          ? 'Web research is turned off in this workspace’s AI settings.'
          : opts.browserScraperAvailable ? undefined : opts.browserScraperReason ?? 'The private browser scraper is unavailable.',
      };
    }
    if (name === 'web_search') {
      return {
        name,
        available: opts.webResearchEnabled && opts.webResearchAvailable,
        approval,
        reason: !opts.webResearchEnabled
          ? 'Web research is turned off in this workspace’s AI settings.'
          : opts.webResearchAvailable ? undefined : 'No web research runtime is available.',
      };
    }
    if (name === 'fetch_site_page') {
      return {
        name,
        available: Boolean(opts.siteUrl) && opts.webResearchEnabled && opts.webResearchAvailable,
        approval,
        reason: !opts.siteUrl
          ? 'No site address is set in this workspace’s AI settings.'
          : !opts.webResearchEnabled
            ? 'Web research is turned off in this workspace’s AI settings.'
            : opts.webResearchAvailable ? undefined : 'No site research runtime is available.',
      };
    }
    if (name === 'search_crm' || name === 'search_crm_notes' || name === 'read_crm_record' || name === 'crm_report' || name === 'propose_crm_update') {
      return opts.crmInstalled
        ? { name, available: true, approval }
        : { name, available: false, approval, reason: 'The CRM module is not set up in this workspace yet.' };
    }
    if (name === 'read_brand_kit' && !opts.brandKitFolderId) {
      return { name, available: true, approval, reason: 'No workspace-wide brand folder is chosen; selected managed companies can still use their own Drive/Brand kit folder.' };
    }
    return TOOL_REGISTRY[name]
      ? { name, available: true, approval }
      : { name, available: false, approval, reason: 'Not implemented by this server.' };
  });
}

export function toolSpecs(tools: AgentTool[]): ToolSpec[] {
  return tools.map((t) => {
    const schema = z.toJSONSchema(t.schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}
