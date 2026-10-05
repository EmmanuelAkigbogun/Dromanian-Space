import type { z } from 'zod';
import type { CitationRegistry } from '../citations.js';

export interface RunScope {
  item_ids?: string[];
  channel_id?: string;
  thread_root_id?: string;
}

export type SourceKind = 'drive_item' | 'channel' | 'crm_record' | 'task' | 'web';

export interface RunContext {
  runId: string;
  workspaceId: string;
  actorId: string;
  scope: RunScope;
  /** Knowledge items the run may retrieve from; null means everything the requester can open. */
  allowedItemIds: string[] | null;
  citations: CitationRegistry;
  recordSource(kind: SourceKind, refId: string, opts?: { itemId?: string; channelId?: string; label?: string }): Promise<void>;
  signal: AbortSignal;
  /** Per-run memo for lookups such as the requester's channels. */
  memo: Map<string, unknown>;
  /** Workspace AI settings the tools depend on. */
  settings: { brandKitFolderId: string | null; siteUrl: string | null };
  /** Present only on coordinator runs (team chat); specialists cannot delegate. */
  delegate?: (tasks: Array<{ agent: string; instruction: string }>, toolUseId: string) => Promise<ToolOutput>;
}

export interface ProposalInfo {
  id: string;
  action_type: string;
  summary: string;
  status: string;
}

export interface ToolOutput {
  /** Text returned to the model. */
  content: string;
  /** Safe, user-facing summary stored with the invocation (no document text). */
  summary: Record<string, unknown>;
  status?: 'succeeded' | 'failed' | 'proposed' | 'denied';
  isError?: boolean;
  proposal?: ProposalInfo;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Progress label shown while the tool runs. */
  label(input: z.infer<S>): string;
  run(ctx: RunContext, input: z.infer<S>, call: { toolUseId: string }): Promise<ToolOutput>;
}

export function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool<S> {
  return tool;
}

/** Wraps untrusted workspace text so the model can tell data from instructions. */
export function quoteData(tag: string, attrs: Record<string, string | number | null | undefined>, body: string): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, "'")}"`)
    .join(' ');
  return `<${tag}${a ? ' ' + a : ''}>\n${body.replace(new RegExp(`</${tag}>`, 'gi'), '')}\n</${tag}>`;
}
