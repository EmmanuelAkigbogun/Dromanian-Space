// Team chat, durable execution and the queue-backed API, through the real
// database, PostgREST and Auth emulation. The model is a deterministic
// double: this is NOT evidence of a live Anthropic request.
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV_FILE } from '../../tools/local-database/lib.ts';
import { admin, createChannel, createUser, createWorkspace, pool, postMessage, q, type TestUser } from '../helpers/db.ts';
import { issueAccessToken } from '../../server/database.js';
import { executeRun } from '../../server/agents/engine.js';
import { startRun } from '../../server/agents/start.js';
import { enqueueRun, tailRun } from '../../server/agents/tail.js';
import { drainQueue } from '../../server/jobs/runner.js';
import type { AgentRunner } from '../../server/agents/agno.js';
import type { SseChannel } from '../../server/http.js';
import { GET as statusEndpoint } from '../../api/ai/status.js';
import { POST as mentionEndpoint } from '../../api/agents/mention.js';
import { GET as reattachEndpoint } from '../../api/agents/run.js';

let user: TestUser;
let other: TestUser;
let ws: string;
let doc: string;
const agents: Record<string, string> = {};

async function token(u: TestUser): Promise<string> {
  const [session] = await admin<{ id: string }>(
    `INSERT INTO auth.sessions (user_id, expires_at) VALUES ($1, now() + interval '10 minutes') RETURNING id`,
    [u.id],
  );
  return issueAccessToken(u, session.id, 600).token;
}

function collector(): SseChannel & { events: Array<[string, unknown]> } {
  let closed = false;
  const events: Array<[string, unknown]> = [];
  return { events, send: (e, d) => void events.push([e, d]), close: () => void (closed = true), get closed() { return closed; } };
}

beforeAll(async () => {
  loadEnvFile(ENV_FILE);
  // Nothing here may reach a real provider.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
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
  let configuredSpecialists: string[] = [];
  let configuredTools: string[] = [];

  beforeAll(async () => {
    const agentRunner: AgentRunner = {
      async run(input, callbacks) {
        configuredSpecialists = input.specialists.map((specialist) => specialist.name);
        configuredTools = input.agent.tools;
        callbacks.onTeam?.('Tally', 'working');
        const source = await callbacks.callTool({ id: 'read-tally', name: 'read_file', input: { item_id: doc } });
        expect(source.content).toContain('EUR 180 per night');
        callbacks.onTeam?.('Inka', 'working');
        return {
          text: 'Tally confirmed EUR 180 per night [1]. Inka drafted the summary.',
          model: 'test-double',
          usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0 },
        };
      },
    };
    parent = await startRun(user.id, {
      workspace_id: ws, agent_id: agents.cerebras_coordinator, message: 'What is our hotel budget? Draft a summary.', idempotency_key: randomUUID(),
    });
    const outcome = await executeRun(parent.run_id, { agentRunner, provider: { name: 'test-double', configured: () => true, startSession: () => { throw new Error('unused'); } } });
    expect(outcome.status).toBe('completed');
  });

  it('gives the lead its direct tools and bounded delegation without an unconditional fan-out', async () => {
    expect(configuredSpecialists).toEqual([]);
    expect(configuredTools).toContain('read_file');
    expect(configuredTools).toContain('delegate_to_specialists');
    const tasks = await q<{ status: string }>(user, 'SELECT status FROM agent_team_tasks WHERE parent_run_id = $1', [parent.run_id]);
    expect(tasks).toEqual([]);
    const children = await q<{ status: string; requested_by: string }>(user, 'SELECT status, requested_by FROM agent_runs WHERE parent_run_id = $1', [parent.run_id]);
    expect(children).toEqual([]);
    const citations = await q<{ item_id: string }>(user, 'SELECT item_id FROM agent_citations WHERE run_id = $1', [parent.run_id]);
    expect(citations).toEqual([{ item_id: doc }]);
    const sources = await q<{ item_id: string }>(user, `SELECT item_id FROM agent_run_sources WHERE run_id = $1 AND kind = 'drive_item'`, [parent.run_id]);
    expect(sources).toEqual([{ item_id: doc }]);
    // Specialists inside a team run do not notify separately.
    const notes = await admin(`SELECT id FROM notifications WHERE entity_id IN (SELECT id FROM agent_runs WHERE parent_run_id = $1)`, [parent.run_id]);
    expect(notes).toHaveLength(0);
  });

  it('runs an explicitly selected specialist and persists its child run', async () => {
    const teamEvents: unknown[] = [];
    let specialistRuns = 0;
    const agentRunner: AgentRunner = {
      async run(input, callbacks) {
        if (input.agent.kind !== 'coordinator') {
          specialistRuns++;
          return {
            text: `${input.agent.name} completed the focused support task.`,
            model: 'test-double',
            usage: { input_tokens: 20, output_tokens: 8, cache_read_tokens: 0, cache_write_tokens: 0 },
          };
        }
        const delegated = await callbacks.callTool({
          id: 'delegate-support',
          name: 'delegate_to_specialists',
          input: {
            tasks: [
              {
                agent: '@CUSTOMER-SUPPORT',
                instruction: 'Draft a short evidence-aware response for this support request.',
              },
              {
                agent: 'customer-support',
                instruction: '  Draft a short evidence-aware response for this support request.  ',
              },
            ],
          },
        });
        expect(delegated.isError).not.toBe(true);
        expect(delegated.content).toContain('completed the focused support task');
        return {
          text: 'The Customer Support Manager completed the requested support draft.',
          model: 'test-double',
          usage: { input_tokens: 40, output_tokens: 12, cache_read_tokens: 0, cache_write_tokens: 0 },
        };
      },
    };
    const delegatedParent = await startRun(user.id, {
      workspace_id: ws,
      agent_id: agents.cerebras_coordinator,
      message: 'Ask customer support for a response draft.',
      idempotency_key: randomUUID(),
    });
    const outcome = await executeRun(delegatedParent.run_id, {
      agentRunner,
      provider: { name: 'test-double', configured: () => true, startSession: () => { throw new Error('unused'); } },
      events: { emit: (event, data) => void (event === 'team' && teamEvents.push(data)) },
    });
    expect(outcome.status).toBe('completed');
    expect(specialistRuns).toBe(1);
    expect(teamEvents.length).toBeGreaterThanOrEqual(3);
    expect(teamEvents.every((data) => Array.isArray((data as { tasks?: unknown[] }).tasks))).toBe(true);
    expect(teamEvents.at(-1)).toMatchObject({
      tasks: [{ agent: 'Customer Support Manager', status: 'completed' }],
    });
    const tasks = await q<{ status: string }>(user, 'SELECT status FROM agent_team_tasks WHERE parent_run_id = $1', [delegatedParent.run_id]);
    expect(tasks).toEqual([{ status: 'completed' }]);
    const children = await q<{ status: string; requested_by: string; depth: number }>(
      user,
      'SELECT status, requested_by, depth FROM agent_runs WHERE parent_run_id = $1',
      [delegatedParent.run_id],
    );
    expect(children).toEqual([{ status: 'completed', requested_by: user.id, depth: 1 }]);
  });

  it('aborts active specialists and terminalizes work not started after the parent stops', async () => {
    const controller = new AbortController();
    const specialistStarts: string[] = [];
    const teamEvents: Array<{ tasks?: Array<{ status: string }> }> = [];
    const agentRunner: AgentRunner = {
      async run(input, callbacks) {
        if (input.agent.kind !== 'coordinator') {
          specialistStarts.push(input.agent.description);
          controller.abort();
          throw new DOMException('Parent stopped', 'AbortError');
        }
        await callbacks.callTool({
          id: 'delegate-aborted-team',
          name: 'delegate_to_specialists',
          input: {
            tasks: [
              { agent: 'customer-support', instruction: 'Prepare the support response for the cancellation test.' },
              { agent: 'marketing-strategist', instruction: 'Prepare the marketing response for the cancellation test.' },
              { agent: 'project-manager', instruction: 'Prepare the project response for the cancellation test.' },
              { agent: 'finance-analyst', instruction: 'Prepare the finance response for the cancellation test.' },
            ],
          },
        });
        throw new DOMException('Parent stopped', 'AbortError');
      },
    };
    const stoppedParent = await startRun(user.id, {
      workspace_id: ws,
      agent_id: agents.cerebras_coordinator,
      message: 'Delegate several tasks, then stop.',
      idempotency_key: randomUUID(),
    });
    const outcome = await executeRun(stoppedParent.run_id, {
      agentRunner,
      provider: { name: 'test-double', configured: () => true, startSession: () => { throw new Error('unused'); } },
      signal: controller.signal,
      events: {
        emit: (event, data) => {
          if (event === 'team') teamEvents.push(data as { tasks?: Array<{ status: string }> });
        },
      },
    });
    expect(outcome.status).toBe('cancelled');
    expect(specialistStarts).toHaveLength(1);

    const children = await q<{ id: string; status: string }>(
      user,
      'SELECT id, status FROM agent_runs WHERE parent_run_id = $1 ORDER BY created_at, id',
      [stoppedParent.run_id],
    );
    expect(children).toHaveLength(4);
    expect(children.every((child) => child.status === 'cancelled')).toBe(true);
    const tasks = await q<{ status: string; finished_at: string | null }>(
      user,
      'SELECT status, finished_at FROM agent_team_tasks WHERE parent_run_id = $1 ORDER BY ordinal',
      [stoppedParent.run_id],
    );
    expect(tasks).toHaveLength(4);
    expect(tasks.every((task) => task.status === 'cancelled' && task.finished_at !== null)).toBe(true);
    const balances = await admin<{ run_id: string; tokens: number }>(
      `SELECT run_id, sum(tokens)::int AS tokens
       FROM ai_usage_ledger
       WHERE run_id = ANY($1::uuid[]) AND kind IN ('reservation', 'release')
       GROUP BY run_id`,
      [children.map((child) => child.id)],
    );
    expect(balances).toHaveLength(4);
    expect(balances.every((balance) => balance.tokens === 0)).toBe(true);
    expect(teamEvents.at(-1)?.tasks?.every((task) => task.status === 'cancelled')).toBe(true);
  });

  it('rechecks cancellation after the provider resolves and before finalization', async () => {
    const controller = new AbortController();
    const emitted: string[] = [];
    const agentRunner: AgentRunner = {
      async run() {
        controller.abort();
        return {
          text: 'This late provider answer must not be committed.',
          model: 'test-double',
          usage: { input_tokens: 15, output_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0 },
        };
      },
    };
    const stopped = await startRun(user.id, {
      workspace_id: ws,
      agent_id: agents.github_customer_support,
      message: 'Stop at the provider completion boundary.',
      idempotency_key: randomUUID(),
    });
    const outcome = await executeRun(stopped.run_id, {
      agentRunner,
      provider: { name: 'test-double', configured: () => true, startSession: () => { throw new Error('unused'); } },
      signal: controller.signal,
      events: { emit: (event) => void emitted.push(event) },
    });
    expect(outcome.status).toBe('cancelled');
    expect(emitted).not.toContain('snapshot');
    expect(emitted).not.toContain('reply');
    const [saved] = await q<{ status: string; content: string }>(
      user,
      `SELECT run.status, message.content
       FROM agent_runs run
       JOIN agent_messages message ON message.id = run.output_message_id
       WHERE run.id = $1`,
      [stopped.run_id],
    );
    expect(saved.status).toBe('cancelled');
    expect(saved.content).not.toContain('late provider answer');
  });

  it('does not invoke a tool after an external Stop signal', async () => {
    const controller = new AbortController();
    let toolError: unknown;
    const agentRunner: AgentRunner = {
      async run(_input, callbacks) {
        controller.abort();
        try {
          await callbacks.callTool({ id: 'late-read', name: 'read_file', input: { item_id: doc } });
        } catch (error) {
          toolError = error;
          throw error;
        }
        throw new Error('The stopped tool unexpectedly ran.');
      },
    };
    const stopped = await startRun(user.id, {
      workspace_id: ws,
      agent_id: agents.github_customer_support,
      message: 'Stop before invoking the tool.',
      idempotency_key: randomUUID(),
    });
    const outcome = await executeRun(stopped.run_id, {
      agentRunner,
      provider: { name: 'test-double', configured: () => true, startSession: () => { throw new Error('unused'); } },
      signal: controller.signal,
    });
    expect(outcome.status).toBe('cancelled');
    expect(toolError).toMatchObject({ name: 'AbortError' });
    expect(await admin(
      'SELECT id FROM agent_tool_invocations WHERE run_id = $1',
      [stopped.run_id],
    )).toHaveLength(0);
  });

  it('exposes configured-site fetch only when web research is enabled', async () => {
    const captures: Array<{ tools: string[]; domains: string[] }> = [];
    const agentRunner: AgentRunner = {
      async run(input) {
        captures.push({
          tools: [...input.agent.tools],
          domains: [...(input.web_fetch_domains ?? [])],
        });
        return {
          text: 'No fetch was executed.',
          model: 'test-double',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
        };
      },
    };
    try {
      await admin(
        `UPDATE workspace_ai_settings
         SET site_url = 'https://www.example.com', web_research_enabled = false
         WHERE workspace_id = $1`,
        [ws],
      );
      const disabled = await startRun(user.id, {
        workspace_id: ws,
        agent_id: agents.github_seo_specialist,
        message: 'Inspect the configured site.',
        idempotency_key: randomUUID(),
      });
      expect((await executeRun(disabled.run_id, {
        agentRunner,
        provider: { name: 'test-double', configured: () => true, startSession: () => { throw new Error('unused'); } },
      })).status).toBe('completed');

      await admin(
        'UPDATE workspace_ai_settings SET web_research_enabled = true WHERE workspace_id = $1',
        [ws],
      );
      const enabled = await startRun(user.id, {
        workspace_id: ws,
        agent_id: agents.github_seo_specialist,
        message: 'Inspect the configured site.',
        idempotency_key: randomUUID(),
      });
      expect((await executeRun(enabled.run_id, {
        agentRunner,
        provider: { name: 'test-double', configured: () => true, startSession: () => { throw new Error('unused'); } },
      })).status).toBe('completed');
    } finally {
      await admin(
        'UPDATE workspace_ai_settings SET site_url = NULL, web_research_enabled = false WHERE workspace_id = $1',
        [ws],
      );
    }
    expect(captures).toHaveLength(2);
    expect(captures[0].tools).not.toContain('fetch_site_page');
    expect(captures[0].domains).toEqual([]);
    expect(captures[1].tools).toContain('fetch_site_page');
    expect(captures[1].domains).toEqual(['www.example.com']);
  });

  it('stores the Agno coordinator answer in the conversation timeline', async () => {
    const timeline = await q<{ kind: string; role: string; agent_name: string; content: string }>(
      user, 'SELECT kind, role, agent_name, content FROM agent_conversation_timeline($1)', [parent.conversation_id]);
    expect(timeline.filter((m) => m.kind === 'delegation')).toEqual([]);
    expect(timeline.at(-1)).toMatchObject({ kind: 'chat', role: 'assistant', agent_name: 'Company Portfolio Director' });
  });

  it('lets the requester reattach to the run and nobody else', async () => {
    const mine = collector();
    await tailRun(parent.run_id, user.id, mine, 5000);
    const names = mine.events.map(([e]) => e);
    expect(names).toContain('snapshot');
    expect(mine.events.filter(([e]) => e === 'team').at(-1)?.[1]).toMatchObject({ tasks: [{ agent: 'Tally', status: 'completed' }, { agent: 'Inka', status: 'completed' }] });
    expect(mine.events.at(-1)).toEqual(['done', expect.objectContaining({ status: 'completed', served_model: 'test-double' })]);

    const response = await reattachEndpoint(new Request(`http://localhost/api/agents/run?run_id=${parent.run_id}`, {
      headers: { authorization: `Bearer ${await token(other)}` },
    }));
    expect(await response.text()).toContain('"status":"not_found"');
  });
});

describe('durable execution through the worker queue', () => {
  it('resumes a run whose worker died, from its persisted state', async () => {
    const run = await startRun(user.id, { workspace_id: ws, agent_id: agents.github_customer_support, message: 'Hello', idempotency_key: randomUUID() });
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
  it('keeps a selected managed company in the persisted run scope', async () => {
    const company = (await q<{ id: string }>(user, `
      INSERT INTO crm_companies (workspace_id, name, is_client, owner_id, created_by)
      VALUES ($1, 'Agent client', true, $2, $2) RETURNING id
    `, [ws, user.id]))[0].id;
    const started = await startRun(user.id, {
      workspace_id: ws,
      agent_id: agents.cerebras_coordinator,
      message: 'Summarize this company.',
      scope: { company_id: company },
      idempotency_key: randomUUID(),
    });
    const [run] = await q<{ scope: { company_id?: string } }>(user, 'SELECT scope FROM agent_runs WHERE id = $1', [started.run_id]);
    expect(run.scope.company_id).toBe(company);
  });

  it('rejects forged agent image attachments before a run is persisted', async () => {
    await expect(startRun(user.id, {
      workspace_id: ws,
      agent_id: agents.github_customer_support,
      message: 'What is in this image?',
      scope: { attachments: [{
        path: `agent-images/${user.id}/missing.png`,
        name: 'missing.png',
        mime_type: 'image/png',
        size: 123,
      }] },
      idempotency_key: randomUUID(),
    })).rejects.toThrow('missing or does not match');
  });

  it('reports honest readiness: connectors, site and tool availability', async () => {
    const response = await statusEndpoint(new Request(`http://localhost/api/ai/status?workspace_id=${ws}`, {
      headers: { authorization: `Bearer ${await token(user)}` },
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      provider: { configured: boolean }; connectors: Array<{ kind: string; status: string }>; tools: Array<{ name: string; available: boolean }>;
    };
    expect(body.provider.configured).toBe(false);
    expect(body.connectors).toHaveLength(11);
    expect(body.connectors.every((c) => c.status === 'not_connected')).toBe(true);
    expect(body.tools.find((t) => t.name === 'fetch_site_page')).toMatchObject({ available: false });
    const denied = await statusEndpoint(new Request(`http://localhost/api/ai/status?workspace_id=${ws}`, {
      headers: { authorization: `Bearer ${await token(other)}` },
    }));
    expect(denied.status).toBe(403);
  });

  it('queues mention runs for the worker and ignores the coordinator handle', async () => {
    const channel = await createChannel(user, ws, { name: 'general-team' });
    const message = await postMessage(user, channel, '@cerebras-analyst how many tasks are open? cc @team');
    const response = await mentionEndpoint(new Request('http://localhost/api/agents/mention', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(user)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: message }),
    }));
    expect(response.status).toBe(202);
    const { runs } = await response.json() as { runs: Array<{ run_id: string; handle: string }> };
    expect(runs.map((r) => r.handle)).toEqual(['cerebras-analyst']);
    const jobs = await admin<{ status: string }>(`SELECT status FROM jobs WHERE kind = 'agent.run' AND idempotency_key = $1`, [`run:${runs[0].run_id}`]);
    expect(jobs).toEqual([{ status: 'queued' }]);
    await admin(`UPDATE jobs SET status = 'cancelled' WHERE idempotency_key = $1`, [`run:${runs[0].run_id}`]);
  });
});
