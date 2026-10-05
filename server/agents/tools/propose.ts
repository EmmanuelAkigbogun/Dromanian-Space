import { z } from 'zod';
import { rpc } from '../../supabase.js';
import { channelLabel, resolveChannel, resolveProject } from './read.js';
import { defineTool, type RunContext, type ToolOutput } from './types.js';

interface ProposalResult {
  status: 'proposed' | 'blocked_audience' | 'denied';
  proposal_id?: string;
  reason?: string;
  sources?: Array<{ kind: string; label: string | null }>;
}

async function propose(
  ctx: RunContext,
  toolUseId: string,
  actionType: 'create_task' | 'save_document' | 'post_message',
  args: Record<string, unknown>,
  summary: string,
): Promise<ToolOutput> {
  const result = await rpc<ProposalResult>('agent_create_proposal', {
    p_run_id: ctx.runId,
    p_tool_use_id: toolUseId,
    p_action_type: actionType,
    p_arguments: args,
    p_summary: summary,
  });
  if (result.status === 'proposed' && result.proposal_id) {
    return {
      content:
        `Proposed: ${summary}. It is waiting for the requester to approve it in the app; it has NOT been done. ` +
        'Tell the requester it is ready for their review.',
      summary: { action: actionType, summary },
      status: 'proposed',
      proposal: { id: result.proposal_id, action_type: actionType, summary, status: 'pending' },
    };
  }
  if (result.status === 'blocked_audience') {
    const labels = (result.sources ?? []).map((s) => s.label ?? s.kind).slice(0, 5);
    return {
      content:
        `Not proposed: ${result.reason ?? 'the audience of this action cannot open some sources used in this conversation.'} ` +
        `Sources involved: ${labels.join(', ') || 'unknown'}. Offer to keep the result private instead.`,
      summary: { action: actionType, blocked: true, sources: labels },
      status: 'denied',
    };
  }
  return {
    content: `Not proposed: ${result.reason ?? 'the requester is not allowed to do this.'}`,
    summary: { action: actionType, denied: true },
    status: 'denied',
  };
}

interface MemberMatch {
  query: string;
  user_id: string;
  display_name: string | null;
  username: string | null;
}

export const proposeTask = defineTool({
  name: 'propose_task',
  description:
    'Propose a task for the requester to approve. Assignees are workspace members by name or username; the task is created only after approval.',
  schema: z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    assignees: z.array(z.string().min(1).max(100)).max(10).optional().describe('Names or usernames of workspace members'),
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('YYYY-MM-DD'),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    project: z.string().max(200).optional().describe('Project name or id'),
  }),
  label: (i) => `Proposing task “${i.title}”`,
  async run(ctx, input, call) {
    const names = input.assignees ?? [];
    const assigneeIds: string[] = [];
    const assigneeNames: string[] = [];
    if (names.length) {
      const matches = await rpc<MemberMatch[]>('agent_resolve_members_for', {
        p_actor: ctx.actorId,
        p_workspace_id: ctx.workspaceId,
        p_names: names,
      });
      for (const name of names) {
        const found = matches.filter((m) => m.query === name);
        const ids = [...new Set(found.map((m) => m.user_id))];
        if (ids.length === 0) {
          return { content: `No workspace member matches "${name}". Ask the requester who should own it.`, summary: { error: 'unknown_assignee' }, isError: true };
        }
        if (ids.length > 1) {
          const options = found.map((m) => `${m.display_name ?? m.username} (@${m.username})`).join(', ');
          return { content: `"${name}" matches several members: ${options}. Use a username.`, summary: { error: 'ambiguous_assignee' }, isError: true };
        }
        assigneeIds.push(ids[0]);
        assigneeNames.push(found[0].display_name ?? found[0].username ?? name);
      }
    }
    let projectId: string | null = null;
    let projectName: string | null = null;
    if (input.project) {
      const project = await resolveProject(ctx, input.project);
      if (!project) return { content: 'No project with that name that the requester can open.', summary: { error: 'unknown_project' }, isError: true };
      if (!project.can_edit) return { content: `The requester cannot add tasks to "${project.name}".`, summary: { error: 'project_read_only' }, isError: true };
      projectId = project.id;
      projectName = project.name;
    }
    const args = {
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? 'medium',
      // Noon UTC keeps the calendar date stable across time zones.
      due_date: input.due_date ? `${input.due_date}T12:00:00.000Z` : null,
      project_id: projectId,
      assignee_ids: [...new Set(assigneeIds)],
      source_channel_id: ctx.scope.channel_id ?? null,
    };
    const summary =
      `Create task “${input.title}”` +
      (assigneeNames.length ? ` for ${assigneeNames.join(', ')}` : '') +
      (input.due_date ? `, due ${input.due_date}` : '') +
      (projectName ? ` in ${projectName}` : '');
    return propose(ctx, call.toolUseId, 'create_task', args, summary);
  },
});

export const proposeDocument = defineTool({
  name: 'propose_document',
  description:
    'Propose saving a Markdown document to Drive (the requester’s files, or a folder they can edit). It is saved only after approval.',
  schema: z.object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(100_000).describe('Full document in Markdown'),
    folder_id: z.string().uuid().optional().describe('Drive folder id; omit for the requester’s own files'),
  }),
  label: (i) => `Drafting “${i.title}”`,
  async run(ctx, input, call) {
    let folderName: string | null = null;
    if (input.folder_id) {
      const [folder] = await rpc<Array<{ name: string; kind: string }>>('agent_scope_items_for', {
        p_actor: ctx.actorId,
        p_item_ids: [input.folder_id],
      });
      if (!folder || folder.kind !== 'folder') {
        return { content: 'That folder was not found, or the requester cannot open it.', summary: { error: 'unknown_folder' }, isError: true };
      }
      folderName = folder.name;
    }
    const summary = `Save document “${input.title}”${folderName ? ` in ${folderName}` : ' in My files'}`;
    return propose(ctx, call.toolUseId, 'save_document', { title: input.title, body: input.body, folder_id: input.folder_id ?? null }, summary);
  },
});

export const proposeChannelMessage = defineTool({
  name: 'propose_channel_message',
  description:
    'Propose posting a message in a channel or direct conversation the requester belongs to (optionally as a thread reply). It is posted, attributed to this agent and the approver, only after approval.',
  schema: z.object({
    channel: z.string().min(1).max(100).describe('Channel name (without #) or id'),
    content: z.string().min(1).max(8000),
    thread_root_id: z.string().uuid().optional(),
  }),
  label: (i) => `Drafting a message for #${i.channel.replace(/^#/, '')}`,
  async run(ctx, input, call) {
    const channel = await resolveChannel(ctx, input.channel);
    if (!channel) {
      return { content: 'No conversation with that name among the ones the requester belongs to.', summary: { error: 'not_found' }, isError: true };
    }
    const summary = input.thread_root_id ? `Reply in a thread in ${channelLabel(channel)}` : `Post in ${channelLabel(channel)}`;
    return propose(
      ctx,
      call.toolUseId,
      'post_message',
      { channel_id: channel.id, parent_id: input.thread_root_id ?? null, content: input.content },
      summary,
    );
  },
});
