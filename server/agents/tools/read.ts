import { z } from 'zod';
import { rpc } from '../../supabase.js';
import { describeLocation } from '../citations.js';
import { embeddingsConfigured, embedTexts, toPgVector } from '../../knowledge/embed.js';
import { defineTool, quoteData, type RunContext } from './types.js';

const uuid = z.string().uuid();

interface SearchRow {
  result_type: 'message' | 'channel' | 'person' | 'file' | 'file_text' | 'task' | 'agent';
  id: string;
  title: string;
  snippet: string;
  link: string;
  context: string;
  created_at: string;
  channel_id: string | null;
  item_id: string | null;
}

interface ChunkRow {
  chunk_id: string;
  item_id?: string;
  item_name: string;
  chunk_index: number;
  content: string;
  location: Record<string, unknown>;
  total_chunks?: number;
  truncated?: boolean;
}

interface ScopeItem {
  id: string;
  name: string;
  kind: string;
  mime_type: string | null;
  index_status: string | null;
  index_message: string | null;
  truncated: boolean;
  chunk_count: number | null;
}

export interface ChannelRow {
  id: string;
  name: string;
  is_private: boolean;
  is_direct: boolean;
}

export async function memberChannels(ctx: RunContext): Promise<ChannelRow[]> {
  const key = 'channels';
  if (!ctx.memo.has(key)) {
    ctx.memo.set(key, await rpc<ChannelRow[]>('agent_channels_for', { p_actor: ctx.actorId, p_workspace_id: ctx.workspaceId }));
  }
  return ctx.memo.get(key) as ChannelRow[];
}

export async function resolveChannel(ctx: RunContext, ref: string | undefined): Promise<ChannelRow | null> {
  const channels = await memberChannels(ctx);
  if (!ref) return ctx.scope.channel_id ? (channels.find((c) => c.id === ctx.scope.channel_id) ?? null) : null;
  const needle = ref.trim().replace(/^#/, '').toLowerCase();
  return channels.find((c) => c.id === ref.trim()) ?? channels.find((c) => c.name.toLowerCase() === needle) ?? null;
}

export function channelLabel(c: ChannelRow): string {
  return c.is_direct ? 'a direct message' : `#${c.name}`;
}

async function scopeItems(ctx: RunContext, ids: string[]): Promise<ScopeItem[]> {
  if (ids.length === 0) return [];
  return rpc<ScopeItem[]>('agent_scope_items_for', { p_actor: ctx.actorId, p_item_ids: ids });
}

function formatPassages(ctx: RunContext, rows: ChunkRow[], itemIdOf: (r: ChunkRow) => string): string {
  return rows
    .map((r) => {
      const p = ctx.citations.add({
        chunkId: r.chunk_id,
        itemId: itemIdOf(r),
        itemName: r.item_name,
        location: r.location ?? {},
        content: r.content,
      });
      return quoteData('passage', { n: p.n, file: r.item_name, item_id: p.itemId, location: describeLocation(r.location ?? {}) }, r.content);
    })
    .join('\n\n');
}

export const searchWorkspace = defineTool({
  name: 'search_workspace',
  description:
    'Search messages, channels, people, files (names and indexed text), tasks and agents in this workspace. Only returns what the requester can open. Use it to find where something was discussed or which file or task is relevant.',
  schema: z.object({
    query: z.string().min(2).max(200).describe('Words to search for'),
    types: z
      .array(z.enum(['message', 'channel', 'person', 'file', 'task', 'agent']))
      .max(6)
      .optional()
      .describe('Limit to these result types'),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  label: (i) => `Searching the workspace for “${i.query}”`,
  async run(ctx, input) {
    const rows = await rpc<SearchRow[]>('search_workspace_for', {
      p_actor: ctx.actorId,
      p_workspace_id: ctx.workspaceId,
      p_query: input.query,
      p_types: input.types ?? null,
      p_limit: input.limit ?? 10,
    });
    if (rows.length === 0) return { content: 'No results.', summary: { results: 0 } };
    const lines: string[] = [];
    for (const r of rows) {
      if (r.result_type === 'message' && r.channel_id) {
        await ctx.recordSource('channel', r.channel_id, { channelId: r.channel_id, label: r.context });
      } else if (r.result_type === 'channel' && r.channel_id && r.context === 'Private channel') {
        await ctx.recordSource('channel', r.channel_id, { channelId: r.channel_id, label: r.title });
      } else if ((r.result_type === 'file' || r.result_type === 'file_text') && r.item_id) {
        await ctx.recordSource('drive_item', r.item_id, { itemId: r.item_id, label: r.title });
      } else if (r.result_type === 'task') {
        await ctx.recordSource('task', r.id, { label: r.title });
      }
      const when = r.created_at ? r.created_at.slice(0, 10) : '';
      lines.push(
        quoteData(
          'result',
          { type: r.result_type === 'file_text' ? 'file' : r.result_type, title: r.title, context: r.context, date: when, link: r.link, item_id: r.item_id },
          r.snippet ?? '',
        ),
      );
    }
    return {
      content: lines.join('\n'),
      summary: { results: rows.length, types: [...new Set(rows.map((r) => r.result_type))] },
    };
  },
});

export const searchKnowledge = defineTool({
  name: 'search_knowledge',
  description:
    'Search the text of indexed documents and files (PDF, DOCX, TXT, Markdown, CSV) the requester can open, within this agent’s allowed sources. Returns numbered passages; cite them as [n].',
  schema: z.object({
    query: z.string().min(2).max(500).describe('What to look for, in natural language or keywords'),
    item_ids: z.array(uuid).max(20).optional().describe('Restrict to these files'),
    limit: z.number().int().min(1).max(12).optional(),
  }),
  label: (i) => `Searching documents for “${i.query}”`,
  async run(ctx, input) {
    let filter = ctx.allowedItemIds;
    if (input.item_ids?.length) {
      filter = filter ? input.item_ids.filter((id) => filter!.includes(id)) : input.item_ids;
      if (filter.length === 0) {
        return { content: 'None of those files are among the sources this agent may use.', summary: { results: 0 }, isError: true };
      }
    }
    let embedding: string | null = null;
    let model: string | null = null;
    if (embeddingsConfigured()) {
      try {
        const e = await embedTexts([input.query], 'query', ctx.signal);
        embedding = toPgVector(e.vectors[0]);
        model = e.model;
      } catch {
        embedding = null; // keyword retrieval still works
      }
    }
    const rows = await rpc<ChunkRow[]>('knowledge_search_for', {
      p_actor: ctx.actorId,
      p_workspace_id: ctx.workspaceId,
      p_query: input.query,
      p_item_ids: filter,
      p_limit: input.limit ?? 8,
      p_query_embedding: embedding,
      p_embedding_model: model,
    });
    const notes: string[] = [];
    if (filter) {
      const items = await scopeItems(ctx, filter);
      const unreadable = items.filter((i) => i.index_status !== 'ready');
      for (const i of unreadable) {
        notes.push(`"${i.name}" could not be searched: ${i.index_message ?? `index status is ${i.index_status ?? 'not indexed yet'}`}.`);
      }
      const truncated = items.filter((i) => i.truncated);
      for (const i of truncated) notes.push(`Only the first part of "${i.name}" is indexed (the file is very large).`);
    }
    for (const r of rows) {
      await ctx.recordSource('drive_item', r.item_id!, { itemId: r.item_id!, label: r.item_name });
    }
    const body = rows.length ? formatPassages(ctx, rows, (r) => r.item_id!) : 'No matching passages.';
    return {
      content: notes.length ? `${body}\n\nNotes:\n- ${notes.join('\n- ')}` : body,
      summary: { results: rows.length, files: [...new Set(rows.map((r) => r.item_name))].slice(0, 10), unreadable: notes.length },
    };
  },
});

export const readFile = defineTool({
  name: 'read_file',
  description:
    'Read the indexed text of one file or document the requester can open, in order, a window at a time. Returns numbered passages; cite them as [n].',
  schema: z.object({
    item_id: uuid.describe('Drive item id (from search results or the selected sources)'),
    from_chunk: z.number().int().min(0).optional().describe('Continue from this passage index'),
  }),
  label: () => 'Reading a file',
  async run(ctx, input) {
    if (ctx.allowedItemIds && !ctx.allowedItemIds.includes(input.item_id)) {
      return { content: 'This file is not among the sources this agent may use.', summary: { error: 'out_of_scope' }, isError: true };
    }
    const [item] = await scopeItems(ctx, [input.item_id]);
    if (!item) return { content: 'File not found, or the requester cannot open it.', summary: { error: 'not_found' }, isError: true };
    if (item.kind === 'folder') return { content: `"${item.name}" is a folder, not a file.`, summary: { error: 'folder' }, isError: true };
    if (item.index_status !== 'ready') {
      const reason = item.index_message ?? `Its index status is ${item.index_status ?? 'not indexed yet'}.`;
      return { content: `"${item.name}" cannot be read: ${reason}`, summary: { file: item.name, status: item.index_status }, isError: true };
    }
    const rows = await rpc<ChunkRow[]>('knowledge_read_item_for', {
      p_actor: ctx.actorId,
      p_item_id: input.item_id,
      p_from_chunk: input.from_chunk ?? 0,
      p_max_chunks: 12,
    });
    await ctx.recordSource('drive_item', input.item_id, { itemId: input.item_id, label: item.name });
    if (rows.length === 0) return { content: `No more text in "${item.name}".`, summary: { file: item.name, passages: 0 } };
    const first = rows[0].chunk_index;
    const last = rows[rows.length - 1].chunk_index;
    const total = rows[0].total_chunks ?? rows.length;
    const more = last + 1 < total ? `\n\nShowing passages ${first}–${last} of ${total}. Call read_file with from_chunk=${last + 1} for more.` : '';
    const truncated = item.truncated ? '\n\nNote: only the first part of this very large file is indexed.' : '';
    return {
      content: formatPassages(ctx, rows, () => input.item_id) + more + truncated,
      summary: { file: item.name, passages: rows.length, total },
    };
  },
});

interface ConversationRow {
  id: string;
  author_name: string;
  is_agent: boolean;
  content: string;
  created_at: string;
  parent_id: string | null;
  reply_count: number;
  channel_name: string;
  is_direct: boolean;
}

export async function readConversation(ctx: RunContext, channel: ChannelRow, rootId: string | null, limit: number, before?: string): Promise<string> {
  const rows = await rpc<ConversationRow[]>('agent_read_conversation_for', {
    p_actor: ctx.actorId,
    p_channel_id: channel.id,
    p_root_id: rootId,
    p_limit: limit,
    p_before: before ?? null,
  });
  await ctx.recordSource('channel', channel.id, { channelId: channel.id, label: channelLabel(channel) });
  if (rows.length === 0) return 'No messages.';
  return rows
    .map((m) =>
      quoteData(
        'message',
        {
          id: m.id,
          author: m.author_name,
          time: m.created_at.slice(0, 16).replace('T', ' '),
          replies: m.parent_id === null && m.reply_count > 0 ? m.reply_count : null,
          reply_to: m.parent_id,
        },
        m.content,
      ),
    )
    .join('\n');
}

export const readConversationTool = defineTool({
  name: 'read_conversation',
  description:
    'Read recent messages of a channel or direct conversation the requester belongs to, or one thread. Without arguments it reads the conversation this request came from.',
  schema: z.object({
    channel: z.string().max(100).optional().describe('Channel name (without #) or id'),
    thread_root_id: uuid.optional().describe('Read this thread (root message id) instead of the channel timeline'),
    limit: z.number().int().min(1).max(100).optional(),
    before: z.string().datetime({ offset: true }).optional().describe('Only messages before this time (ISO 8601)'),
  }),
  label: (i) => (i.channel ? `Reading #${i.channel.replace(/^#/, '')}` : 'Reading the conversation'),
  async run(ctx, input) {
    const channel = await resolveChannel(ctx, input.channel);
    if (!channel) {
      return {
        content: input.channel ? 'No conversation with that name among the ones the requester belongs to.' : 'Specify a channel.',
        summary: { error: 'not_found' },
        isError: true,
      };
    }
    const root = input.thread_root_id ?? (input.channel ? null : (ctx.scope.thread_root_id ?? null));
    const text = await readConversation(ctx, channel, root, input.limit ?? 50, input.before);
    return { content: text, summary: { conversation: channelLabel(channel), thread: Boolean(root) } };
  },
});

interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  project_name: string | null;
  assignees: string[];
}

export interface ProjectRow {
  id: string;
  name: string;
  status: string;
  can_edit: boolean;
}

export async function resolveProject(ctx: RunContext, ref: string): Promise<ProjectRow | null> {
  const projects = await rpc<ProjectRow[]>('agent_projects_for', { p_actor: ctx.actorId, p_workspace_id: ctx.workspaceId });
  const needle = ref.trim().toLowerCase();
  return (
    projects.find((p) => p.id === ref.trim()) ??
    projects.find((p) => p.name.toLowerCase() === needle) ??
    projects.find((p) => p.name.toLowerCase().startsWith(needle)) ??
    null
  );
}

export const listTasks = defineTool({
  name: 'list_tasks',
  description: 'List tasks the requester can see, optionally for one project or only their own. Open tasks by default.',
  schema: z.object({
    project: z.string().max(200).optional().describe('Project name or id'),
    mine: z.boolean().optional().describe('Only tasks the requester created or is assigned to'),
    include_completed: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  label: (i) => (i.project ? `Listing tasks in ${i.project}` : 'Listing tasks'),
  async run(ctx, input) {
    let projectId: string | null = null;
    if (input.project) {
      const project = await resolveProject(ctx, input.project);
      if (!project) return { content: 'No project with that name that the requester can open.', summary: { error: 'not_found' }, isError: true };
      projectId = project.id;
    }
    const rows = await rpc<TaskRow[]>('agent_list_tasks_for', {
      p_actor: ctx.actorId,
      p_workspace_id: ctx.workspaceId,
      p_project_id: projectId,
      p_mine: input.mine ?? false,
      p_include_completed: input.include_completed ?? false,
      p_limit: input.limit ?? 50,
    });
    for (const t of rows) await ctx.recordSource('task', t.id, { label: t.title });
    if (rows.length === 0) return { content: 'No matching tasks.', summary: { results: 0 } };
    const lines = rows.map((t) =>
      quoteData(
        'task',
        {
          id: t.id,
          status: t.status,
          priority: t.priority,
          due: t.due_date ? t.due_date.slice(0, 10) : null,
          project: t.project_name,
          assignees: t.assignees.join(', ') || null,
          link: `/tasks/${t.id}`,
        },
        t.title,
      ),
    );
    return { content: lines.join('\n'), summary: { results: rows.length } };
  },
});
