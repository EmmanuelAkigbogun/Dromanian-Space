import { z } from 'zod';
import { rpc } from '../../database.js';
import { channelLabel, resolveChannel, resolveProject } from './read.js';
import { defineTool } from './types.js';

interface MemberMatch {
  query: string;
  user_id: string;
  display_name: string | null;
  username: string | null;
}

interface SubmitResult {
  status: 'submitted';
  request_ids: string[];
  new: number;
  approvers: number;
  requester_is_approver: boolean;
}

const task = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  assignees: z.array(z.string().min(1).max(100)).max(10).optional().describe('Names or usernames of workspace members, as written in the material'),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('YYYY-MM-DD'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  project: z.string().max(200).optional().describe('Project name or id'),
});

/**
 * Sends tasks to the workspace's project managers. Unlike propose_task, the
 * requester does not approve them: a project manager reviews, edits and
 * approves each one in the Tasks page.
 */
export const submitTasksForApproval = defineTool({
  name: 'submit_tasks_for_approval',
  description:
    'Send one or more tasks to the project managers for approval. Use it for action items from a conversation or a pasted list. ' +
    'Owners that do not match a member are kept in the description. Nothing is created until a project manager approves.',
  schema: z.object({ tasks: z.array(task).min(1).max(25) }),
  label: (i) => `Sending ${i.tasks.length} ${i.tasks.length === 1 ? 'task' : 'tasks'} for approval`,
  async run(ctx, input, call) {
    const names = [...new Set(input.tasks.flatMap((t) => t.assignees ?? []))];
    const matches = names.length
      ? await rpc<MemberMatch[]>('agent_resolve_members_for', { p_actor: ctx.actorId, p_workspace_id: ctx.workspaceId, p_names: names })
      : [];
    const unmatched = new Set<string>();
    const resolve = (name: string): MemberMatch | null => {
      const found = matches.filter((m) => m.query === name);
      const ids = new Set(found.map((m) => m.user_id));
      if (ids.size === 1) return found[0];
      unmatched.add(name);
      return null;
    };

    const rows: Array<Record<string, unknown>> = [];
    for (const t of input.tasks) {
      const assigneeIds: string[] = [];
      const unresolved: string[] = [];
      for (const name of t.assignees ?? []) {
        const m = resolve(name);
        if (m) assigneeIds.push(m.user_id);
        else unresolved.push(name);
      }
      let projectId: string | null = null;
      if (t.project) {
        const project = await resolveProject(ctx, t.project);
        if (!project) {
          return { content: `No project named "${t.project}" that the requester can open. Leave the project out or ask which one.`, summary: { error: 'unknown_project' }, isError: true };
        }
        projectId = project.id;
      }
      const note = unresolved.length ? `Suggested owner: ${unresolved.join(', ')} (not matched to a member).` : '';
      rows.push({
        title: t.title,
        description: [t.description?.trim(), note].filter(Boolean).join('\n\n') || null,
        priority: t.priority ?? 'medium',
        // Noon UTC keeps the calendar date stable across time zones.
        due_date: t.due_date ? `${t.due_date}T12:00:00.000Z` : null,
        project_id: projectId,
        assignee_ids: [...new Set(assigneeIds)],
      });
    }

    const channel = await resolveChannel(ctx, undefined);
    const source = ctx.scope.session_id ? 'an AI session in a direct message' : channel ? channelLabel(channel) : null;
    const result = await rpc<SubmitResult>('agent_submit_task_requests', {
      p_run_id: ctx.runId,
      p_tool_use_id: call.toolUseId,
      p_tasks: rows,
      p_source_label: source,
    });
    const count = result.request_ids.length;
    const who = result.requester_is_approver && result.approvers === 1 ? 'the requester (the only approver)' : 'the project managers';
    return {
      content:
        `Sent ${count} ${count === 1 ? 'task' : 'tasks'} to ${who} for approval. They have NOT been created yet; ` +
        'a project manager approves them in the Tasks page.' +
        (unmatched.size ? ` These owners did not match a member and were noted in the description instead: ${[...unmatched].join(', ')}.` : ''),
      summary: { submitted: count, unmatched_owners: [...unmatched] },
      status: 'succeeded',
    };
  },
});
