// Follows a persisted run for a viewer. The worker writes checkpoints, events
// and team task state; this relays them as server-sent events. A viewer can
// disconnect and reattach at any time (GET /api/agents/run?run_id=…).
import type { SseChannel } from '../http.js';
import { rpc, serviceClient } from '../supabase.js';

const POLL_MS = 400;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'awaiting_approval']);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Queues a run for the worker (idempotent per run). */
export async function enqueueRun(runId: string, workspaceId: string, actorId: string): Promise<void> {
  await rpc('enqueue_job', {
    p_kind: 'agent.run',
    p_workspace_id: workspaceId,
    p_principal_id: actorId,
    p_payload: { run_id: runId },
    p_idempotency_key: `run:${runId}`,
    p_max_attempts: 3,
  });
}

export async function tailRun(runId: string, userId: string, channel: SseChannel, maxMs = 10 * 60_000): Promise<void> {
  const db = serviceClient();
  const deadline = Date.now() + maxMs;
  const names = new Map<string, string>();
  let lastContent: string | null = null;
  let lastEvent = 0;
  let lastTeam = '';
  try {
    while (!channel.closed && Date.now() < deadline) {
      const { data: run } = await db
        .from('agent_runs')
        .select('status, output_message_id, error_code, error_message, requested_by, served_model')
        .eq('id', runId)
        .maybeSingle();
      if (!run || run.requested_by !== userId) {
        channel.send('done', { status: 'not_found' });
        return;
      }
      const [msg, events, tasks] = await Promise.all([
        db.from('agent_messages').select('content').eq('id', run.output_message_id).maybeSingle(),
        db.from('agent_run_events').select('id, type, data').eq('run_id', runId).gt('id', lastEvent).order('id').limit(100),
        db.from('agent_team_tasks').select('id, ordinal, agent_id, child_run_id').eq('parent_run_id', runId).order('ordinal'),
      ]);
      const content = (msg.data?.content as string | undefined) ?? '';
      if (content !== lastContent) {
        channel.send('snapshot', { text: content });
        lastContent = content;
      }
      for (const e of events.data ?? []) {
        lastEvent = e.id as number;
        const data = (e.data ?? {}) as Record<string, unknown>;
        if (e.type === 'tool_started') channel.send('tool', { phase: 'started', ...data });
        else if (e.type === 'tool_finished') channel.send('tool', { phase: 'finished', ...data });
        else channel.send(e.type as string, data);
      }
      if (tasks.data && tasks.data.length > 0) {
        const missing = tasks.data.map((t) => t.agent_id as string).filter((id) => !names.has(id));
        if (missing.length) {
          const { data: agents } = await db.from('workspace_agents').select('id, name').in('id', missing);
          for (const a of agents ?? []) names.set(a.id as string, a.name as string);
        }
        const { data: children } = await db.from('agent_runs').select('id, status').in('id', tasks.data.map((t) => t.child_run_id));
        const team = tasks.data.map((t) => ({
          task_id: t.id,
          ordinal: t.ordinal,
          agent: names.get(t.agent_id as string) ?? 'Specialist',
          status: children?.find((c) => c.id === t.child_run_id)?.status ?? 'queued',
        }));
        const key = JSON.stringify(team);
        if (key !== lastTeam) {
          channel.send('team', { tasks: team });
          lastTeam = key;
        }
      }
      if (TERMINAL.has(run.status as string)) {
        channel.send('done', {
          status: run.status,
          error_code: run.error_code,
          error_message: run.error_message,
          served_model: run.served_model,
        });
        return;
      }
      await sleep(POLL_MS);
    }
    if (!channel.closed) channel.send('detached', { reason: 'The run is still in progress; reopen the conversation to follow it.' });
  } finally {
    channel.close();
  }
}
