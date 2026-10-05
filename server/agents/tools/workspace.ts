import { z } from 'zod';
import { rpc } from '../../supabase.js';
import { describeLocation } from '../citations.js';
import { proposeAction } from './propose.js';
import { defineTool, quoteData } from './types.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

function dayStart(d: string): string {
  return `${d}T00:00:00.000Z`;
}

interface EventRow {
  id: string;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  location: string | null;
  organizer: string | null;
  participants: string[];
}

export const readCalendar = defineTool({
  name: 'read_calendar',
  description:
    "Read the requester's own calendar events (ones they organize or attend) between two dates, up to 62 days apart.",
  schema: z.object({
    from: isoDate.describe('First day, YYYY-MM-DD'),
    to: isoDate.describe('Last day (inclusive), YYYY-MM-DD'),
  }),
  label: (i) => `Reading the calendar ${i.from} to ${i.to}`,
  async run(ctx, input) {
    const to = new Date(dayStart(input.to));
    to.setUTCDate(to.getUTCDate() + 1);
    const rows = await rpc<EventRow[]>('agent_calendar_for', {
      p_actor: ctx.actorId,
      p_workspace_id: ctx.workspaceId,
      p_from: dayStart(input.from),
      p_to: to.toISOString(),
    });
    if (rows.length === 0) return { content: 'No events in that period (or the range is longer than 62 days).', summary: { events: 0 } };
    const body = rows
      .map((e) =>
        quoteData(
          'event',
          {
            start: e.all_day ? e.start_at.slice(0, 10) : e.start_at.slice(0, 16).replace('T', ' ') + ' UTC',
            end: e.all_day ? e.end_at.slice(0, 10) : e.end_at.slice(0, 16).replace('T', ' ') + ' UTC',
            location: e.location,
            organizer: e.organizer,
            participants: e.participants.join(', ') || null,
          },
          `${e.title}${e.description ? `\n${e.description}` : ''}`,
        ),
      )
      .join('\n');
    return { content: body, summary: { events: rows.length } };
  },
});

interface MemberMatch {
  query: string;
  user_id: string;
  display_name: string | null;
  username: string | null;
}

export const proposeCalendarEvent = defineTool({
  name: 'propose_calendar_event',
  description:
    'Propose a calendar event for the requester to approve. Events are visible to the whole workspace. It is created only after approval.',
  schema: z.object({
    title: z.string().min(1).max(200),
    start_at: z.string().datetime({ offset: true }).describe('ISO 8601 with offset'),
    end_at: z.string().datetime({ offset: true }),
    description: z.string().max(4000).optional(),
    location: z.string().max(200).optional(),
    participants: z.array(z.string().min(1).max(100)).max(20).optional().describe('Names or usernames of workspace members'),
  }),
  label: (i) => `Proposing event “${i.title}”`,
  async run(ctx, input, call) {
    if (new Date(input.end_at) <= new Date(input.start_at)) {
      return { content: 'The event must end after it starts.', summary: { error: 'invalid_time' }, isError: true };
    }
    const ids: string[] = [];
    const names: string[] = [];
    if (input.participants?.length) {
      const matches = await rpc<MemberMatch[]>('agent_resolve_members_for', {
        p_actor: ctx.actorId,
        p_workspace_id: ctx.workspaceId,
        p_names: input.participants,
      });
      for (const name of input.participants) {
        const found = [...new Set(matches.filter((m) => m.query === name).map((m) => m.user_id))];
        if (found.length !== 1) {
          return {
            content: found.length ? `"${name}" matches several members; use a username.` : `No workspace member matches "${name}".`,
            summary: { error: 'participant' },
            isError: true,
          };
        }
        ids.push(found[0]);
        const m = matches.find((x) => x.user_id === found[0])!;
        names.push(m.display_name ?? m.username ?? name);
      }
    }
    const when = new Date(input.start_at).toISOString().slice(0, 16).replace('T', ' ');
    const summary = `Add “${input.title}” to the calendar on ${when} UTC${names.length ? ` with ${names.join(', ')}` : ''}`;
    return proposeAction(ctx, call.toolUseId, 'create_event', {
      title: input.title,
      start_at: input.start_at,
      end_at: input.end_at,
      description: input.description ?? null,
      location: input.location ?? null,
      participant_ids: [...new Set(ids)],
    }, summary);
  },
});

export const workspaceMetrics = defineTool({
  name: 'workspace_metrics',
  description:
    'Compute a vetted, read-only aggregate over workspace records the requester can see: tasks_by_status, tasks_by_assignee, tasks_by_project, tasks_overdue, tasks_completed_per_week, messages_per_channel, deals_by_stage (per currency), contacts_by_lifecycle. Report only numbers it returns.',
  schema: z.object({
    metric: z.enum([
      'tasks_by_status', 'tasks_by_assignee', 'tasks_by_project', 'tasks_overdue', 'tasks_completed_per_week',
      'messages_per_channel', 'deals_by_stage', 'contacts_by_lifecycle',
    ]),
    from: isoDate.optional().describe('Start date for time-bounded metrics (default: 30 days ago)'),
    to: isoDate.optional().describe('End date, exclusive (default: now)'),
  }),
  label: (i) => `Calculating ${i.metric.replaceAll('_', ' ')}`,
  async run(ctx, input) {
    const data = await rpc<Record<string, unknown>>('agent_workspace_metrics', {
      p_run_id: ctx.runId,
      p_metric: input.metric,
      p_from: input.from ? dayStart(input.from) : null,
      p_to: input.to ? dayStart(input.to) : null,
    });
    const rows = Array.isArray(data.rows) ? data.rows.length : 0;
    return { content: JSON.stringify(data), summary: { metric: input.metric, rows } };
  },
});

interface BrandItem {
  id: string;
  name: string;
  kind: string;
}
interface ChunkRow {
  chunk_id: string;
  item_id?: string;
  item_name: string;
  content: string;
  location: Record<string, unknown>;
}

export const readBrandKit = defineTool({
  name: 'read_brand_kit',
  description:
    "Read the workspace brand kit (voice, tone, vocabulary, visual rules) from the folder an admin chose in AI settings. Optionally search it for a topic. Returns numbered passages; cite them as [n].",
  schema: z.object({ topic: z.string().min(2).max(200).optional().describe('What to look up, e.g. "tone of voice"') }),
  label: () => 'Reading the brand kit',
  async run(ctx, input) {
    if (!ctx.settings.brandKitFolderId) {
      return {
        content: 'No brand kit is configured for this workspace. Tell the requester an admin can choose a brand kit folder in AI settings, and continue with general best practice.',
        summary: { configured: false },
      };
    }
    const items = await rpc<BrandItem[]>('agent_brand_kit_items_for', { p_actor: ctx.actorId, p_workspace_id: ctx.workspaceId });
    if (items.length === 0) {
      return { content: 'The brand kit folder is empty, or the requester cannot open its files.', summary: { configured: true, files: 0 } };
    }
    let rows: ChunkRow[];
    if (input.topic) {
      rows = await rpc<ChunkRow[]>('knowledge_search_for', {
        p_actor: ctx.actorId,
        p_workspace_id: ctx.workspaceId,
        p_query: input.topic,
        p_item_ids: items.map((i) => i.id),
        p_limit: 8,
        p_query_embedding: null,
        p_embedding_model: null,
      });
    } else {
      rows = [];
      for (const item of items.slice(0, 5)) {
        const part = await rpc<ChunkRow[]>('knowledge_read_item_for', { p_actor: ctx.actorId, p_item_id: item.id, p_from_chunk: 0, p_max_chunks: 3 });
        rows.push(...part.map((r) => ({ ...r, item_id: item.id })));
      }
    }
    for (const r of rows) await ctx.recordSource('drive_item', r.item_id!, { itemId: r.item_id!, label: r.item_name });
    if (rows.length === 0) {
      return { content: `The brand kit files are not indexed yet: ${items.map((i) => i.name).join(', ')}.`, summary: { files: items.length, passages: 0 } };
    }
    const body = rows
      .map((r) => {
        const p = ctx.citations.add({ chunkId: r.chunk_id, itemId: r.item_id!, itemName: r.item_name, location: r.location ?? {}, content: r.content });
        return quoteData('passage', { n: p.n, file: r.item_name, location: describeLocation(r.location ?? {}) }, r.content);
      })
      .join('\n\n');
    return { content: body, summary: { files: items.length, passages: rows.length } };
  },
});

export const readPersonalNotes = defineTool({
  name: 'read_personal_notes',
  description: "Read the requester's private notes kept with this agent (goals, preferences, reflections). They are private to the requester.",
  schema: z.object({}),
  label: () => 'Reading your private notes',
  async run(ctx) {
    const rows = await rpc<Array<{ content: string; created_at: string }>>('agent_personal_notes_for', { p_run_id: ctx.runId, p_limit: 50 });
    if (rows.length === 0) return { content: 'No saved notes yet.', summary: { notes: 0 } };
    return {
      content: rows.map((n) => quoteData('note', { saved: n.created_at.slice(0, 10) }, n.content)).join('\n'),
      summary: { notes: rows.length },
    };
  },
});

export const savePersonalNote = defineTool({
  name: 'save_personal_note',
  description: "Save a short private note for the requester (only when they ask you to remember something). Only the requester can see it.",
  schema: z.object({ content: z.string().min(1).max(2000) }),
  label: () => 'Saving a private note',
  async run(ctx, input) {
    await rpc('agent_save_personal_note', { p_run_id: ctx.runId, p_content: input.content });
    return { content: 'Saved privately.', summary: { saved: true } };
  },
});

export const delegateToSpecialists = defineTool({
  name: 'delegate_to_specialists',
  description:
    'Assign up to 4 focused tasks to specialist agents by handle (for example "tally"). Each specialist works with the requester’s own access and returns its result; their actions still need approval. Call it once per request, then combine the results.',
  schema: z.object({
    tasks: z
      .array(
        z.object({
          agent: z.string().min(2).max(40).describe('Specialist handle'),
          instruction: z.string().min(10).max(4000).describe('Self-contained task with the context the specialist needs'),
        }),
      )
      .min(1)
      .max(4),
  }),
  label: (i) => `Assigning ${i.tasks.length} task${i.tasks.length === 1 ? '' : 's'} to specialists`,
  async run(ctx, input, call) {
    if (!ctx.delegate) {
      return { content: 'Only the team coordinator can delegate.', summary: { error: 'not_coordinator' }, isError: true };
    }
    return ctx.delegate(input.tasks, call.toolUseId);
  },
});
