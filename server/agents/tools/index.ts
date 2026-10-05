import { readCrmRecord, proposeCrmUpdate } from './crm.js';
import { z } from 'zod';
import type { ToolSpec } from '../../ai/provider.js';
import { computeCsvMetrics } from './csv-metrics.js';
import { proposeChannelMessage, proposeDocument, proposeTask } from './propose.js';
import { listTasks, readConversationTool, readFile, searchKnowledge, searchWorkspace } from './read.js';
import type { AgentTool } from './types.js';

/** Client tools the engine implements. web_search is a provider (server) tool. */
export const TOOL_REGISTRY: Record<string, AgentTool> = Object.fromEntries(
  [readCrmRecord, proposeCrmUpdate, searchWorkspace, searchKnowledge, readFile, readConversationTool, listTasks, computeCsvMetrics, proposeTask, proposeDocument, proposeChannelMessage].map(
    (t) => [t.name, t as unknown as AgentTool],
  ),
);

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
};

export function toolAvailability(names: string[], opts: { webResearchEnabled: boolean; crmInstalled: boolean }): ToolAvailability[] {
  return names.map((name) => {
    const approval = APPROVAL[name] ?? 'none';
    if (name === 'web_search') {
      return opts.webResearchEnabled
        ? { name, available: true, approval }
        : { name, available: false, approval, reason: 'Web research is turned off in this workspace’s AI settings.' };
    }
    if (name === 'read_crm_record' || name === 'propose_crm_update') {
      return opts.crmInstalled && TOOL_REGISTRY[name]
        ? { name, available: true, approval }
        : { name, available: false, approval, reason: 'The CRM module is not set up in this workspace yet.' };
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
