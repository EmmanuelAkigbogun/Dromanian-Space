import { z } from 'zod';
import type { ToolSpec } from '../../ai/provider.js';
import { readCrmRecord, proposeCrmUpdate } from './crm.js';
import { computeCsvMetrics } from './csv-metrics.js';
import { proposeChannelMessage, proposeDocument, proposeTask } from './propose.js';
import { listTasks, readConversationTool, readFile, searchKnowledge, searchWorkspace } from './read.js';
import {
  delegateToSpecialists, proposeCalendarEvent, readBrandKit, readCalendar, readPersonalNotes, savePersonalNote, workspaceMetrics,
} from './workspace.js';
import type { AgentTool } from './types.js';

/** Client tools the engine implements. web_search and fetch_site_page are provider (server) tools. */
export const TOOL_REGISTRY: Record<string, AgentTool> = Object.fromEntries(
  [
    readCrmRecord, proposeCrmUpdate, searchWorkspace, searchKnowledge, readFile, readConversationTool, listTasks, computeCsvMetrics,
    proposeTask, proposeDocument, proposeChannelMessage, readCalendar, proposeCalendarEvent, workspaceMetrics, readBrandKit,
    readPersonalNotes, savePersonalNote, delegateToSpecialists,
  ].map((t) => [t.name, t as unknown as AgentTool]),
);

/** Tools the model provider runs itself. */
export const PROVIDER_TOOLS = ['web_search', 'fetch_site_page'];

export const KNOWN_TOOLS = [...Object.keys(TOOL_REGISTRY), ...PROVIDER_TOOLS];

export interface ToolAvailability {
  name: string;
  available: boolean;
  /** Why it is unavailable, in words an admin can act on. */
  reason?: string;
  approval: 'none' | 'review_card';
}

const APPROVAL: Record<string, 'none' | 'review_card'> = {
  propose_task: 'review_card',
  propose_document: 'review_card',
  propose_channel_message: 'review_card',
  propose_crm_update: 'review_card',
  propose_calendar_event: 'review_card',
};

export interface AvailabilityInputs {
  webResearchEnabled: boolean;
  crmInstalled: boolean;
  siteUrl: string | null;
  brandKitFolderId: string | null;
}

export function toolAvailability(names: string[], opts: AvailabilityInputs): ToolAvailability[] {
  return names.map((name) => {
    const approval = APPROVAL[name] ?? 'none';
    if (name === 'web_search') {
      return opts.webResearchEnabled
        ? { name, available: true, approval }
        : { name, available: false, approval, reason: 'Web research is turned off in this workspace’s AI settings.' };
    }
    if (name === 'fetch_site_page') {
      return opts.siteUrl
        ? { name, available: true, approval }
        : { name, available: false, approval, reason: 'No site address is set in this workspace’s AI settings.' };
    }
    if (name === 'read_crm_record' || name === 'propose_crm_update') {
      return opts.crmInstalled
        ? { name, available: true, approval }
        : { name, available: false, approval, reason: 'The CRM module is not set up in this workspace yet.' };
    }
    if (name === 'read_brand_kit' && !opts.brandKitFolderId) {
      return { name, available: true, approval, reason: 'No brand kit folder is chosen yet; drafts use general best practice.' };
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
