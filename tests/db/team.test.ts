/**
 * Twelve-role roster, team delegation, durable execution and the new agent
 * tools at the SQL boundary. Server-only functions run as service_role (as
 * the worker does); everything a person does runs as that `authenticated`
 * user.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember, admin, asService, createChannel, createUser, createWorkspace, expectDenied, pool, postMessage, putObject, q,
  type TestUser,
} from '../helpers/db.ts';

let alice: TestUser; // owner, requester
let bob: TestUser; // admin
let carol: TestUser; // member
let mallory: TestUser; // other tenant
let ws: string;
let wsB: string;
let team: string; // channel: alice + bob
let privateDoc: string; // alice only
const agentIds: Record<string, string> = {};

const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  asService(async (c) => (await c.query(sql, params)).rows as T[]);

async function uploadDoc(user: TestUser, workspace: string, name: string, text: string) {
  const begin = (await q<{ r: { item_id: string; version_id: string; path: string } }>(user,
    `SELECT drive_begin_upload($1, NULL, $2, 'text/plain', 100, NULL) AS r`, [workspace, name]))[0].r;
  await putObject('drive', begin.path, user, 'text/plain', 100);
  await q(user, 'SELECT drive_finalize_upload($1)', [begin.version_id]);
  const source = (await admin<{ id: string }>('SELECT id FROM knowledge_sources WHERE version_id = $1', [begin.version_id]))[0].id;
  await svc('SELECT knowledge_begin_extraction($1)', [source]);
  await svc('SELECT knowledge_store_chunks($1, $2, $3)', [source,
    JSON.stringify([{ index: 0, content: text, location: { start_char: 0, end_char: text.length } }]),
    JSON.stringify({ extractor: 'test', char_count: text.length })]);
  return begin.item_id;
}

async function startRun(actor: TestUser, agent: string, message = 'Hello', workspace = ws) {
  return (await svc<{ r: { run_id: string; conversation_id: string; output_message_id: string } }>(
    `SELECT agent_start_run($1, $2, $3, NULL, $4, '{}', 'interactive', '{}', '{"type":"private"}', $5, 1000) AS r`,
    [actor.id, workspace, agent, message, randomUUID()]))[0].r;
}

async function claim(runId: string, worker = 'test-worker') {
  return (await svc<{ r: { claimed: boolean; reason?: string } }>('SELECT agent_claim_run($1, $2) AS r', [runId, worker]))[0].r;
}

beforeAll(async () => {
  [alice, bob, carol, mallory] = await Promise.all([createUser('t-alice'), createUser('t-bob'), createUser('t-carol'), createUser('t-mallory')]);
  ws = await createWorkspace(alice, 'Team A');
  wsB = await createWorkspace(mallory, 'Team B');
  await addMember(ws, bob, 'admin');
  await addMember(ws, carol);
  team = await createChannel(alice, ws, { name: 'launch', members: [bob] });
  privateDoc = await uploadDoc(alice, ws, 'Board notes.txt', 'Confidential board notes: the launch slips to May.');
  for (const row of await admin<{ id: string; template_key: string }>(
    'SELECT id, template_key FROM workspace_agents WHERE workspace_id = $1 AND is_builtin', [ws])) {
    agentIds[row.template_key] = row.id;
  }
  await svc('SELECT ai_settings_for($1)', [ws]);
  await svc('UPDATE workspace_ai_settings SET max_concurrent_runs = 20 WHERE workspace_id = $1', [ws]);
});

afterAll(() => pool.end());

describe('roster', () => {
  it('archives retired built-ins while keeping their conversations readable and unmentionable', async () => {
    const [old] = await admin<{ id: string }>(
      `INSERT INTO workspace_agents (workspace_id, template_key, name, handle, is_builtin) VALUES ($1, 'writer', 'Writer', 'writer', true) RETURNING id`, [ws]);
    const [version] = await admin<{ id: string }>(
      `INSERT INTO workspace_agent_versions (agent_id, workspace_id, version_no, instructions, tools, model) VALUES ($1, $2, 1, 'x', '{}', 'claude-opus-5-5') RETURNING id`,
      [old.id, ws]);
    await admin('UPDATE workspace_agents SET current_version_id = $1 WHERE id = $2', [version.id, old.id]);
    const run = await startRun(alice, old.id, 'Draft a brief');

    await svc('SELECT agent_seed_workspace($1, NULL)', [ws]);
    const dir = await q<{ template_key: string }>(alice, 'SELECT * FROM agent_directory($1)', [ws]);
    expect(dir.map((d) => d.template_key)).not.toContain('writer');
    expect(dir).toHaveLength(13);
    expect(await q(alice, 'SELECT * FROM agent_conversation_timeline($1)', [run.conversation_id])).toHaveLength(2);

    const msg = await postMessage(alice, team, 'Hey @writer and @team, help');
    expect(await svc('SELECT * FROM agent_mention_targets($1, $2)', [alice.id, msg])).toHaveLength(0);
    const msg2 = await postMessage(alice, team, '@tally how many tasks are open?');
    expect((await svc<{ handle: string }>('SELECT * FROM agent_mention_targets($1, $2)', [alice.id, msg2])).map((t) => t.handle)).toEqual(['tally']);
  });

  it('keeps connector state server-written and member-readable', async () => {
    await expectDenied(q(bob, `INSERT INTO workspace_connectors (workspace_id, kind) VALUES ($1, 'email_inbox')`, [ws]), /permission/);
    await svc(`INSERT INTO workspace_connectors (workspace_id, kind, display_name) VALUES ($1, 'social_accounts', 'Test account')`, [ws]);
    expect(await q(carol, 'SELECT kind FROM workspace_connectors WHERE workspace_id = $1', [ws])).toEqual([{ kind: 'social_accounts' }]);
    expect(await q(mallory, 'SELECT kind FROM workspace_connectors WHERE workspace_id = $1', [ws])).toHaveLength(0);
  });

  it('validates brand kit and site settings and limits them to admins', async () => {
    await expectDenied(q(carol, `SELECT ai_update_settings($1, '{"site_url":"https://example.com"}')`, [ws]), /Only workspace admins/);
    await expectDenied(q(bob, `SELECT ai_update_settings($1, '{"site_url":"http://internal"}')`, [ws]), /check constraint|violates/);
    await expectDenied(q(bob, `SELECT ai_update_settings($1, $2)`, [ws, JSON.stringify({ brand_kit_folder_id: privateDoc })]), /folder/);
    await q(bob, `SELECT ai_update_settings($1, '{"site_url":"https://www.example.com"}')`, [ws]);
    expect((await admin<{ site_url: string }>('SELECT site_url FROM workspace_ai_settings WHERE workspace_id = $1', [ws]))[0].site_url).toBe('https://www.example.com');
  });
});

describe('team delegation', () => {
  let parent: { run_id: string; conversation_id: string };
  let children: Array<{ task_id: string; child_run_id: string; reused: boolean }>;
  const tasks = () => [
    { agent_id: agentIds.data_analyst, instruction: 'Count open tasks by status.' },
    { agent_id: agentIds.copywriter, instruction: 'Draft a launch headline.' },
  ];

  beforeAll(async () => {
    parent = await startRun(alice, agentIds.team_coordinator, 'Plan the launch');
    expect((await claim(parent.run_id)).claimed).toBe(true);
    children = (await svc<{ r: typeof children }>('SELECT agent_delegate($1, $2) AS r', [parent.run_id, JSON.stringify(tasks())]))[0].r;
  });

  it('creates specialist runs for the same requester, one level deep, in the team conversation', async () => {
    expect(children).toHaveLength(2);
    const rows = await q<{ requested_by: string; depth: number; trigger: string; conversation_id: string; parent_run_id: string }>(
      alice, 'SELECT requested_by, depth, trigger, conversation_id, parent_run_id FROM agent_runs WHERE id = ANY($1)', [children.map((c) => c.child_run_id)]);
    for (const r of rows) {
      expect(r).toMatchObject({ requested_by: alice.id, depth: 1, trigger: 'delegation', conversation_id: parent.conversation_id, parent_run_id: parent.run_id });
    }
    const timeline = await q<{ kind: string; agent_name: string }>(alice, 'SELECT kind, agent_name FROM agent_conversation_timeline($1)', [parent.conversation_id]);
    expect(timeline.filter((m) => m.kind === 'delegation').map((m) => m.agent_name).sort()).toEqual(['Inka', 'Inka', 'Tally', 'Tally']);
    expect(await q(bob, 'SELECT id FROM agent_team_tasks WHERE parent_run_id = $1', [parent.run_id])).toHaveLength(0);
  });

  it('reuses tasks when the same delegation is repeated (worker restart)', async () => {
    const again = (await svc<{ r: typeof children }>('SELECT agent_delegate($1, $2) AS r', [parent.run_id, JSON.stringify(tasks())]))[0].r;
    expect(again.map((c) => c.child_run_id)).toEqual(children.map((c) => c.child_run_id));
    expect(again.every((c) => c.reused)).toBe(true);
  });

  it('rejects recursion, coordinators, invisible agents and other tenants', async () => {
    const child = children[0].child_run_id;
    await claim(child);
    await expectDenied(svc('SELECT agent_delegate($1, $2)', [child, JSON.stringify([{ agent_id: agentIds.copywriter, instruction: 'Write.' }])]), /cannot delegate/);
    await expectDenied(svc('SELECT agent_delegate($1, $2)', [parent.run_id, JSON.stringify([{ agent_id: agentIds.team_coordinator, instruction: 'Recurse.' }])]), /not available/);
    const privateAgent = (await q<{ id: string }>(carol, `SELECT id FROM agent_create($1, 'Carol helper', 'carol-helper', 'mine')`, [ws]))[0].id;
    await expectDenied(svc('SELECT agent_delegate($1, $2)', [parent.run_id, JSON.stringify([{ agent_id: privateAgent, instruction: 'Help.' }])]), /not available/);
    const foreign = (await admin<{ id: string }>(`SELECT id FROM workspace_agents WHERE workspace_id = $1 AND template_key = 'data_analyst'`, [wsB]))[0].id;
    await expectDenied(svc('SELECT agent_delegate($1, $2)', [parent.run_id, JSON.stringify([{ agent_id: foreign, instruction: 'Leak.' }])]), /not available/);
  });

  it('enforces the per-team delegation budget', async () => {
    const run = await startRun(alice, agentIds.team_coordinator, 'Big plan');
    await claim(run.run_id);
    const many = (n: number) => Array.from({ length: 4 }, (_, i) => ({ agent_id: agentIds.copywriter, instruction: `Task ${n}-${i}` }));
    await svc('SELECT agent_delegate($1, $2)', [run.run_id, JSON.stringify(many(1))]);
    await svc('SELECT agent_delegate($1, $2)', [run.run_id, JSON.stringify(many(2))]);
    await expectDenied(svc('SELECT agent_delegate($1, $2)', [run.run_id, JSON.stringify(many(3))]), /budget/);
  });

  it('carries specialists’ sources to the team run so sharing is checked against them', async () => {
    const child = children[0];
    await svc(`SELECT agent_record_source($1, 'drive_item', $2, $3, NULL, 'Board notes.txt')`, [child.child_run_id, privateDoc, privateDoc]);
    await svc('SELECT agent_settle_team_task($1)', [child.task_id]);
    const audience = (await svc<{ a: string[] }>(`SELECT agent_action_audience($1, $2, 'post_message', $3) AS a`,
      [ws, alice.id, JSON.stringify({ channel_id: team })]))[0].a;
    const gaps = (await svc<{ g: unknown[] }>('SELECT agent_audience_gaps($1, $2) AS g', [parent.run_id, audience]))[0].g;
    expect(gaps).toHaveLength(1);
  });

  it('propagates cancellation to running and queued specialists', async () => {
    expect((await q<{ r: string }>(alice, 'SELECT agent_cancel_run($1) AS r', [parent.run_id]))[0].r).toBe('cancelling');
    const rows = await admin<{ id: string; status: string; cancel_requested_at: string | null }>(
      'SELECT id, status, cancel_requested_at FROM agent_runs WHERE parent_run_id = $1', [parent.run_id]);
    const running = rows.find((r) => r.id === children[0].child_run_id)!;
    const queued = rows.find((r) => r.id === children[1].child_run_id)!;
    expect(running.cancel_requested_at).not.toBeNull();
    expect(queued.status).toBe('cancelled');
  });
});

describe('durable execution', () => {
  it('restarts a reclaimed run cleanly: partial output and citations are discarded', async () => {
    const run = await startRun(alice, agentIds.support_specialist, 'Summarize the board notes');
    await claim(run.run_id, 'worker-a');
    await svc(`SELECT agent_checkpoint($1, 'worker-a', 'partial answer')`, [run.run_id]);
    const chunk = (await admin<{ id: string }>('SELECT id FROM knowledge_chunks WHERE item_id = $1', [privateDoc]))[0].id;
    await svc('SELECT agent_add_citations($1, $2)', [run.run_id, JSON.stringify([{ ordinal: 1, chunk_id: chunk, quote: 'x' }])]);
    expect((await claim(run.run_id, 'worker-b')).reason).toBe('running_elsewhere');

    await admin(`UPDATE agent_runs SET heartbeat_at = now() - interval '5 minutes' WHERE id = $1`, [run.run_id]);
    expect((await claim(run.run_id, 'worker-b')).claimed).toBe(true);
    const [state] = await admin<{ attempt: number; content: string; citations: number }>(
      `SELECT r.attempt, m.content, (SELECT count(*)::int FROM agent_citations c WHERE c.run_id = r.id) AS citations
       FROM agent_runs r JOIN agent_messages m ON m.id = r.output_message_id WHERE r.id = $1`, [run.run_id]);
    expect(state).toEqual({ attempt: 2, content: '', citations: 0 });
  });

  it('leaves stale runs with a live job to the worker and interrupts them once the job is dead', async () => {
    const run = await startRun(alice, agentIds.support_specialist, 'Stale');
    await claim(run.run_id, 'worker-c');
    await admin(`UPDATE agent_runs SET heartbeat_at = now() - interval '5 minutes' WHERE id = $1`, [run.run_id]);
    const job = (await svc<{ id: string }>(`SELECT enqueue_job('agent.run', $1, $2, $3, $4, now(), 3) AS id`,
      [ws, alice.id, JSON.stringify({ run_id: run.run_id }), `run:${run.run_id}`]))[0].id;
    await svc('SELECT agent_recover_stale_runs()');
    expect((await admin<{ status: string }>('SELECT status FROM agent_runs WHERE id = $1', [run.run_id]))[0].status).toBe('running');
    await admin(`UPDATE jobs SET status = 'dead' WHERE id = $1`, [job]);
    await svc('SELECT agent_recover_stale_runs()');
    expect((await admin<{ status: string }>('SELECT status FROM agent_runs WHERE id = $1', [run.run_id]))[0].status).toBe('interrupted');
  });

  it('returns the same review card when a restarted run proposes the same action again', async () => {
    const run = await startRun(alice, agentIds.support_specialist, 'Propose a task');
    await claim(run.run_id);
    const args = JSON.stringify({ title: 'Follow up', priority: 'medium', assignee_ids: [] });
    const first = (await svc<{ r: { proposal_id: string } }>(`SELECT agent_create_proposal($1, 'tool-a', 'create_task', $2, 'Create task') AS r`, [run.run_id, args]))[0].r;
    const second = (await svc<{ r: { proposal_id: string; reused: boolean } }>(`SELECT agent_create_proposal($1, 'tool-b', 'create_task', $2, 'Create task') AS r`, [run.run_id, args]))[0].r;
    expect(second).toMatchObject({ proposal_id: first.proposal_id, reused: true });
  });
});

describe('personal notes', () => {
  it('are private to their owner, even from workspace admins', async () => {
    const run = await startRun(alice, agentIds.personal_coach, 'Remember I protect Friday mornings');
    await claim(run.run_id);
    await svc(`SELECT agent_save_personal_note($1, 'Protect Friday mornings for deep work')`, [run.run_id]);
    expect(await q(alice, 'SELECT content FROM agent_personal_notes')).toEqual([{ content: 'Protect Friday mornings for deep work' }]);
    expect(await q(bob, 'SELECT content FROM agent_personal_notes WHERE workspace_id = $1', [ws])).toHaveLength(0);
    const bobRun = await startRun(bob, agentIds.personal_coach, 'What do you know about me?');
    await claim(bobRun.run_id);
    expect(await svc('SELECT * FROM agent_personal_notes_for($1, 50)', [bobRun.run_id])).toHaveLength(0);
    expect(await svc('SELECT * FROM agent_personal_notes_for($1, 50)', [run.run_id])).toHaveLength(1);
    await expectDenied(q(alice, `INSERT INTO agent_personal_notes (workspace_id, user_id, agent_id, content) VALUES ($1, $2, $3, 'x')`,
      [ws, alice.id, agentIds.personal_coach]), /permission/);
  });
});

describe('metrics, calendar and reviewed events', () => {
  it('counts only tasks the requester can see and records them as sources', async () => {
    await admin(`INSERT INTO tasks (workspace_id, title, status, created_by) VALUES ($1, 'Alice private task', 'todo', $2)`, [ws, alice.id]);
    const total = async (user: TestUser) => {
      const run = await startRun(user, agentIds.data_analyst, 'Count tasks');
      await claim(run.run_id);
      const r = (await svc<{ r: { rows: Array<{ count: number }> } }>(`SELECT agent_workspace_metrics($1, 'tasks_by_status', NULL, NULL) AS r`, [run.run_id]))[0].r;
      const sources = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM agent_run_sources WHERE run_id = $1 AND kind = 'task'`, [run.run_id]);
      return { count: r.rows.reduce((n, x) => n + Number(x.count), 0), sources: sources[0].n };
    };
    const forAlice = await total(alice);
    const forCarol = await total(carol);
    expect(forAlice.count).toBeGreaterThan(forCarol.count);
    expect(forAlice.sources).toBe(forAlice.count);
    const run = await startRun(alice, agentIds.data_analyst, 'Bad metric');
    await claim(run.run_id);
    await expectDenied(svc(`SELECT agent_workspace_metrics($1, 'raw_sql', NULL, NULL)`, [run.run_id]), /Unsupported metric/);
  });

  it('reads only the requester’s own or attended events', async () => {
    const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await admin(`INSERT INTO calendar_events (workspace_id, user_id, title, start_at, end_at) VALUES ($1, $2, 'Alice 1:1', $3::date + time '10:00', $3::date + time '11:00')`, [ws, alice.id, day]);
    await admin(`INSERT INTO calendar_events (workspace_id, user_id, title, start_at, end_at) VALUES ($1, $2, 'Bob review', $3::date + time '12:00', $3::date + time '13:00')`, [ws, bob.id, day]);
    const events = await svc<{ title: string }>(`SELECT * FROM agent_calendar_for($1, $2, $3::date, $3::date + 1)`, [alice.id, ws, day]);
    expect(events.map((e) => e.title)).toEqual(['Alice 1:1']);
  });

  it('blocks a workspace-visible event built from a private conversation, and creates a clean one once', async () => {
    const leaky = await startRun(alice, agentIds.executive_assistant, 'Schedule from #launch');
    await claim(leaky.run_id);
    await svc(`SELECT agent_record_source($1, 'channel', $2, NULL, $3, '#launch')`, [leaky.run_id, team, team]);
    const start = new Date(Date.now() + 2 * 86400000).toISOString();
    const end = new Date(Date.now() + 2 * 86400000 + 3600000).toISOString();
    const args = JSON.stringify({ title: 'Launch sync', start_at: start, end_at: end, participant_ids: [bob.id] });
    const blocked = (await svc<{ r: { status: string } }>(`SELECT agent_create_proposal($1, 'e1', 'create_event', $2, 'Add event') AS r`, [leaky.run_id, args]))[0].r;
    expect(blocked.status).toBe('blocked_audience');

    const clean = await startRun(alice, agentIds.executive_assistant, 'Schedule a sync');
    await claim(clean.run_id);
    const proposed = (await svc<{ r: { proposal_id: string } }>(`SELECT agent_create_proposal($1, 'e2', 'create_event', $2, 'Add event') AS r`, [clean.run_id, args]))[0].r;
    const hash = (await admin<{ arguments_hash: string }>('SELECT arguments_hash FROM agent_action_proposals WHERE id = $1', [proposed.proposal_id]))[0].arguments_hash;
    const first = (await q<{ r: { status: string; result: { event_id: string } } }>(alice, 'SELECT agent_decide_proposal($1, true, $2) AS r', [proposed.proposal_id, hash]))[0].r;
    expect(first.status).toBe('executed');
    const again = (await q<{ r: { result: { event_id: string } } }>(alice, 'SELECT agent_decide_proposal($1, true, $2) AS r', [proposed.proposal_id, hash]))[0].r;
    expect(again.result.event_id).toBe(first.result.event_id);
    expect(await admin('SELECT user_id FROM event_participants WHERE event_id = $1', [first.result.event_id])).toEqual([{ user_id: bob.id }]);
  });
});
