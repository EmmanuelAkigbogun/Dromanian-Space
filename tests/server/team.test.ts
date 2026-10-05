// Team chat, durable execution and the queue-backed API, through the real
// database, PostgREST and Auth emulation. The model is a deterministic
// double: this is NOT evidence of a live Anthropic request.
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV_FILE, loadOrCreateKeys, signJwt } from '../../tools/local-supabase/lib.ts';
import { admin, createChannel, createUser, createWorkspace, pool, postMessage, q, type TestUser } from '../helpers/db.ts';
import { executeRun } from '../../server/agents/engine.js';
import { startRun } from '../../server/agents/start.js';
import { enqueueRun, tailRun } from '../../server/agents/tail.js';
import { drainQueue } from '../../server/jobs/runner.js';
import { emptyUsage, type ModelProvider, type ToolCall, type TurnResult, type TurnStop } from '../../server/ai/provider.js';
import type { SseChannel } from '../../server/http.js';
import { GET as statusEndpoint } from '../../api/ai/status.js';
import { POST as mentionEndpoint } from '../../api/agents/mention.js';
import { GET as reattachEndpoint } from '../../api/agents/run.js';

let user: TestUser;
let other: TestUser;
let ws: string;
let doc: string;
const agents: Record<string, string> = {};

const turn = (text: string, stop: TurnStop, toolCalls: ToolCall[] = []): TurnResult => ({
  text, stop, toolCalls, refusalCategory: null, usage: emptyUsage(), model: 'test-double', fallbackUsed: false, webSearches: [], webSources: [],
});

async function token(u: TestUser): Promise<string> {
  const keys = await loadOrCreateKeys();
  return signJwt(keys.privateJwk, { sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email }, 600);
}

function collector(): SseChannel & { events: Array<[string, unknown]> } {
  let closed = false;
  const events: Array<[string, unknown]> = [];
  return { events, send: (e, d) => void events.push([e, d]), close: () => void (closed = true), get closed() { return closed; } };
}

beforeAll(async () => {
  loadEnvFile(ENV_FILE);
  delete process.env.ANTHROPIC_API_KEY; // nothing here may reach a real provider
  user = await createUser('team-user');
  other = await createUser('team-other');
  ws = await createWorkspace(user, 'Team chat');
  for (const r of await admin<{ id: string; template_key: string }>('SELECT id, template_key FROM workspace_agents WHERE workspace_id = $1', [ws])) {
    agents[r.template_key] = r.id;
  }
  doc = (await q<{ id: string }>(user, `SELECT (drive_create_document($1, NULL, 'Travel policy', 'The approved travel budget is EUR 180 per night.')).id AS id`, [ws]))[0].id;
  await admin(`UPDATE jobs SET run_after = now() WHERE workspace_id = $1 AND kind = 'knowledge.extract'`, [ws]);
  await drainQueue({ worker: 'team-test-index', workspaceId: ws, kinds: ['knowledge.extract'], deadline: Date.now() + 20000 });
  await admin('UPDATE workspace_ai_settings SET max_concurrent_runs = 20 WHERE workspace_id = $1', [ws]);
});

afterAll(() => pool.end());

describe('team chat', () => {
  let parent: { run_id: string; conversation_id: string };
  const seen: Record<string, string[]> = {};

  beforeAll(async () => {
    const provider: ModelProvider = {
      name: 'test-double',
      configured: () => true,
      startSession: (input) => {
        const who = /^You are ([^,]+),/.exec(input.system)?.[1] ?? '?';
        let step = 0;
        return {
          addToolResults: (results) => void (seen[who] ??= []).push(...results.map((r) => r.content)),
          next: async () => {
            step++;
            if (who === 'Team Lead') {
              if (step === 1) {
                return turn('', 'tool_use', [{ id: 'delegate-1', name: 'delegate_to_specialists', input: { tasks: [
                  { agent: 'tally', instruction: 'Find the approved nightly travel budget in the travel policy.' },
                  { agent: 'inka', instruction: 'Write a one-line summary of the travel budget for the team.' },
                ] } }]);
              }
              return turn('Tally confirmed EUR 180 per night [1]. Inka drafted the summary.', 'end');
            }
            if (step === 1) return turn('', 'tool_use', [{ id: `read-${who}`, name: 'read_file', input: { item_id: doc } }]);
            return turn('The travel budget is EUR 180 per night [1].', 'end');
          },
        };
      },
    };
    parent = await startRun(user.id, {
      workspace_id: ws, agent_id: agents.team_coordinator, message: 'What is our hotel budget? Draft a summary.', idempotency_key: randomUUID(),
    });
    const outcome = await executeRun(parent.run_id, { provider });
    expect(outcome.status).toBe('completed');
  });

  it('runs each specialist under the requester and combines their cited results', async () => {
    const tasks = await q<{ status: string }>(user, 'SELECT status FROM agent_team_tasks WHERE parent_run_id = $1', [parent.run_id]);
    expect(tasks.map((t) => t.status)).toEqual(['completed', 'completed']);
    const children = await q<{ status: string; requested_by: string }>(user, 'SELECT status, requested_by FROM agent_runs WHERE parent_run_id = $1', [parent.run_id]);
    expect(children.every((c) => c.status === 'completed' && c.requested_by === user.id)).toBe(true);
    // The coordinator saw both specialists' answers with citations renumbered into its own registry.
    expect(seen['Team Lead'][0]).toContain('<specialist name="Tally"');
    expect(seen['Team Lead'][0]).toContain('EUR 180 per night [1]');
    const citations = await q<{ item_id: string }>(user, 'SELECT item_id FROM agent_citations WHERE run_id = $1', [parent.run_id]);
    expect(citations).toEqual([{ item_id: doc }]);
    const sources = await q<{ item_id: string }>(user, `SELECT item_id FROM agent_run_sources WHERE run_id = $1 AND kind = 'drive_item'`, [parent.run_id]);
    expect(sources).toEqual([{ item_id: doc }]);
    // Specialists inside a team run do not notify separately.
    const notes = await admin(`SELECT id FROM notifications WHERE entity_id IN (SELECT id FROM agent_runs WHERE parent_run_id = $1)`, [parent.run_id]);
    expect(notes).toHaveLength(0);
  });

  it('shows who did what in the conversation timeline', async () => {
    const timeline = await q<{ kind: string; role: string; agent_name: string; content: string }>(
      user, 'SELECT kind, role, agent_name, content FROM agent_conversation_timeline($1)', [parent.conversation_id]);
    const answers = timeline.filter((m) => m.kind === 'delegation' && m.role === 'assistant');
    expect(answers.map((m) => m.agent_name).sort()).toEqual(['Inka', 'Tally']);
    expect(timeline.at(-1)).toMatchObject({ kind: 'chat', role: 'assistant', agent_name: 'Team Lead' });
  });

  it('lets the requester reattach to the run and nobody else', async () => {
    const mine = collector();
    await tailRun(parent.run_id, user.id, mine, 5000);
    const names = mine.events.map(([e]) => e);
    expect(names).toContain('snapshot');
    expect(mine.events.find(([e]) => e === 'team')?.[1]).toMatchObject({ tasks: [{ agent: 'Tally', status: 'completed' }, { agent: 'Inka', status: 'completed' }] });
    expect(mine.events.at(-1)).toEqual(['done', expect.objectContaining({ status: 'completed', served_model: 'test-double' })]);

    const response = await reattachEndpoint(new Request(`http://localhost/api/agents/run?run_id=${parent.run_id}`, {
      headers: { authorization: `Bearer ${await token(other)}` },
    }));
    expect(await response.text()).toContain('"status":"not_found"');
  });
});

describe('durable execution through the worker queue', () => {
  it('resumes a run whose worker died, from its persisted state', async () => {
    const run = await startRun(user.id, { workspace_id: ws, agent_id: agents.support_specialist, message: 'Hello', idempotency_key: randomUUID() });
    await enqueueRun(run.run_id, ws, user.id);
    // Worker A claims the job and the run, then disappears.
    const [job] = await admin<{ id: string }>(`SELECT id FROM claim_job_by_key('worker-a', 'agent.run', $1, 120)`, [`run:${run.run_id}`]);
    await admin(`SELECT agent_claim_run($1, 'worker-a')`, [run.run_id]);
    await admin(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [job.id]);
    await admin(`UPDATE agent_runs SET heartbeat_at = now() - interval '5 minutes' WHERE id = $1`, [run.run_id]);
    await admin('SELECT agent_recover_stale_runs()'); // must not interrupt: the job is still alive

    await drainQueue({ worker: 'worker-b', kinds: ['agent.run'], deadline: Date.now() + 30000, maxJobs: 5 });
    const [state] = await admin<{ status: string; error_code: string; attempt: number; worker: string }>(
      'SELECT status, error_code, attempt, worker FROM agent_runs WHERE id = $1', [run.run_id]);
    // No provider key in tests: the reclaimed run fails honestly instead of pretending to answer.
    expect(state).toEqual({ status: 'failed', error_code: 'provider_not_configured', attempt: 2, worker: 'worker-b' });
    expect((await admin<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [job.id]))[0].status).toBe('succeeded');
  });
});

describe('API with signed user tokens', () => {
  it('reports honest readiness: connectors, site and tool availability', async () => {
    const response = await statusEndpoint(new Request(`http://localhost/api/ai/status?workspace_id=${ws}`, {
      headers: { authorization: `Bearer ${await token(user)}` },
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      provider: { configured: boolean }; connectors: Array<{ kind: string; status: string }>; tools: Array<{ name: string; available: boolean }>;
    };
    expect(body.provider.configured).toBe(false);
    expect(body.connectors).toHaveLength(7);
    expect(body.connectors.every((c) => c.status === 'not_connected')).toBe(true);
    expect(body.tools.find((t) => t.name === 'fetch_site_page')).toMatchObject({ available: false });
    const denied = await statusEndpoint(new Request(`http://localhost/api/ai/status?workspace_id=${ws}`, {
      headers: { authorization: `Bearer ${await token(other)}` },
    }));
    expect(denied.status).toBe(403);
  });

  it('queues mention runs for the worker and ignores the coordinator handle', async () => {
    const channel = await createChannel(user, ws, { name: 'general-team' });
    const message = await postMessage(user, channel, '@tally how many tasks are open? cc @team');
    const response = await mentionEndpoint(new Request('http://localhost/api/agents/mention', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(user)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: message }),
    }));
    expect(response.status).toBe(202);
    const { runs } = await response.json() as { runs: Array<{ run_id: string; handle: string }> };
    expect(runs.map((r) => r.handle)).toEqual(['tally']);
    const jobs = await admin<{ status: string }>(`SELECT status FROM jobs WHERE kind = 'agent.run' AND idempotency_key = $1`, [`run:${runs[0].run_id}`]);
    expect(jobs).toEqual([{ status: 'queued' }]);
    await admin(`UPDATE jobs SET status = 'cancelled' WHERE idempotency_key = $1`, [`run:${runs[0].run_id}`]);
  });
});
