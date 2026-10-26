// Behavioural checks for the 2026-10-19 migrations on PGlite (see run.mjs).
// tests/db/providers-automation.test.ts covers the same ground on PostgreSQL 17.
import { randomUUID } from 'node:crypto';

let failures = 0;
const ok = (m) => console.log('PASS', m);
const bad = (m) => { failures++; console.log('FAIL', m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

export function helpers(db) {
  async function as(role, claims, sql, params = []) {
    await db.exec('BEGIN');
    try {
      if (role) await db.exec(`SET LOCAL ROLE ${role}`);
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims ?? {})]);
      const r = await db.query(sql, params);
      await db.exec('COMMIT');
      return r.rows;
    } catch (e) {
      await db.exec('ROLLBACK');
      throw e;
    }
  }
  const user = (u, sql, p) => as('authenticated', { sub: u.id, role: 'authenticated', email: u.email }, sql, p);
  const svc = (sql, p) => as('service_role', { role: 'service_role' }, sql, p);
  const admin = async (sql, p) => (await db.query(sql, p)).rows;
  async function createUser(label) {
    const id = randomUUID();
    const email = `${label}-${id.slice(0, 8)}@example.test`;
    await db.query(`INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
      VALUES ($1, $2, crypt('password123', gen_salt('bf')), now(), $3)`, [id, email, { full_name: label }]);
    return { id, email };
  }
  async function createWorkspace(owner, name) {
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}`;
    return (await user(owner, 'SELECT create_workspace_with_owner($1, $2, $3, NULL) AS ws', [name, slug, owner.id]))[0].ws.id;
  }
  async function denied(p, pattern = /permission|denied|admins|not allowed|not active|cannot use|member|Anthropic/i) {
    try { await p; return false; } catch (e) { return pattern.test(e.message) ? true : (console.log('   unexpected error:', e.message), false); }
  }
  return { user, svc, admin, createUser, createWorkspace, denied };
}

/** Runs before the 2026-10-19 migrations: an existing installation. */
export async function pre(db) {
  const h = helpers(db);
  const owner = await h.createUser('legacy-owner');
  const ws = await h.createWorkspace(owner, 'Legacy');
  // Customize Rio; leave Atlas and Talia untouched.
  const rio = (await h.admin(`SELECT id FROM workspace_agents WHERE workspace_id = $1 AND template_key = 'sales_rep'`, [ws]))[0].id;
  await h.user(owner, `SELECT agent_save_config($1, '{"instructions":"Our own sales playbook."}')`, [rio]);
  await h.admin(`INSERT INTO ai_usage_ledger (workspace_id, user_id, kind, model, tokens, input_tokens, output_tokens)
    VALUES ($1, $2, 'usage', 'claude-sonnet-5-5', 0, 1000000, 0)`, [ws, owner.id]);
  console.log('pre-fixture: legacy workspace with a customized Rio');
  return { owner, ws };
}

export default async function smoke(db, legacy) {
  const h = helpers(db);

  if (legacy) {
    const v = await h.admin(`SELECT a.template_key, v.version_no, v.instructions FROM workspace_agents a
      JOIN workspace_agent_versions v ON v.id = a.current_version_id
      WHERE a.workspace_id = $1 AND a.template_key IN ('growth_strategist','recruiter','sales_rep','business_researcher')`, [legacy.ws]);
    const by = Object.fromEntries(v.map((r) => [r.template_key, r]));
    check(by.growth_strategist?.version_no >= 2 && /marketing strategist/.test(by.growth_strategist.instructions), 'upgrade: untouched Atlas refocused as marketing strategist (new version)');
    check(by.recruiter?.version_no >= 2 && /HR assistant/.test(by.recruiter.instructions), 'upgrade: untouched Talia broadened to HR assistant');
    check(by.sales_rep?.instructions === 'Our own sales playbook.', 'upgrade: customized Rio left unchanged');
    check(Boolean(by.business_researcher), 'upgrade: new specialists added to the existing workspace');
    const cost = await h.admin(`SELECT provider, cost_usd FROM ai_usage_ledger WHERE workspace_id = $1 AND kind = 'usage'`, [legacy.ws]);
    check(cost[0]?.provider === 'anthropic' && Number(cost[0]?.cost_usd) === 2, 'upgrade: existing usage backfilled with cost ($2.00 for 1M Sonnet input)');
  }

  const [owner, member, other] = [await h.createUser('owner'), await h.createUser('member'), await h.createUser('other')];
  const wsA = await h.createWorkspace(owner, 'A');
  const wsB = await h.createWorkspace(other, 'B');
  await h.admin(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [wsA, member.id]);

  // Catalog & platform state
  const models = await h.user(member, 'SELECT id, provider FROM ai_models');
  check(models.some((m) => m.id === 'gpt-5.4' && m.provider === 'openai'), 'members can read the model catalog');
  check(await h.denied(h.user(owner, `SELECT ai_report_platform('{"openai":true}', 'gpt-5.4')`)), 'clients cannot report platform state');
  check(await h.denied(h.user(owner, `UPDATE ai_models SET input_per_mtok = 0 WHERE id = 'claude-opus-5-5'`)), 'clients cannot change prices');
  await h.svc(`SELECT ai_report_platform('{"anthropic":false,"openai":true}', 'gpt-5.4')`);
  const fresh = await h.createWorkspace(other, 'Fresh');
  const s = (await h.svc('SELECT (ai_settings_for($1)).*', [fresh]))[0];
  check(s.default_model === 'gpt-5.4' && s.allowed_models.every((m) => m.startsWith('gpt-')), `OpenAI-only server: new workspace defaults to gpt-5.4 (allowed: ${s.allowed_models.join(', ')})`);
  const seeded = await h.admin(`SELECT DISTINCT v.model FROM workspace_agents a JOIN workspace_agent_versions v ON v.id = a.current_version_id WHERE a.workspace_id = $1`, [fresh]);
  check(seeded.length === 1 && seeded[0].model === 'gpt-5.4', 'OpenAI-only server: seeded agents use gpt-5.4');
  const run = (await h.svc(`SELECT agent_start_run($1, $2, (SELECT id FROM workspace_agents WHERE workspace_id = $2 AND handle = 'vera'), NULL, 'hi', '{}', 'interactive', '{}', '{"type":"private"}', $3, 1000) AS r`, [other.id, fresh, randomUUID()]))[0].r;
  check(Boolean(run.run_id), 'OpenAI-only server: an agent run can start in the new workspace');
  await h.svc(`SELECT ai_report_platform('{"anthropic":true,"openai":false}', 'claude-opus-5-5')`);
  check(await h.denied(h.user(owner, `SELECT ai_update_settings($1, '{"allowed_models":["claude-opus-5-5","llama3"],"default_model":"claude-opus-5-5"}')`, [wsA])), 'unsupported provider models are rejected');

  // Costs
  const runId = randomUUID();
  await h.admin(`INSERT INTO ai_usage_ledger (workspace_id, user_id, run_id, kind, model, tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    VALUES ($1, $2, $3, 'usage', 'claude-opus-5-5', 0, 1000000, 100000, 1000000, 0), ($1, $2, $3, 'usage', 'gpt-5.4-2026-03-05', 0, 1000, 1000, 0, 0)`, [wsA, owner.id, runId]);
  const rows = await h.admin('SELECT model, provider, cost_usd FROM ai_usage_ledger WHERE run_id = $1', [runId]);
  const claude = rows.find((r) => r.model === 'claude-opus-5-5');
  const gpt = rows.find((r) => r.model.startsWith('gpt'));
  check(claude.provider === 'anthropic' && Number(claude.cost_usd) === 6.2, `cost estimate for Opus 5.5 usage is $6.20 (got ${claude.cost_usd})`);
  check(gpt.provider === 'openai' && gpt.cost_usd === null, 'unpriced OpenAI usage is recorded without an invented cost');
  const summary = await h.svc('SELECT * FROM ai_cost_summary($1)', [wsA]);
  check(summary.length === 2 && Number(summary.find((r) => r.model.startsWith('gpt')).unpriced_rows) === 1, 'cost summary groups by model and counts unpriced rows');
  check(await h.denied(h.user(owner, 'SELECT * FROM ai_cost_summary($1)', [wsA])), 'cost summary is server-only');
  await h.admin(`UPDATE ai_models SET input_per_mtok = 1, output_per_mtok = 10 WHERE id = 'gpt-5.4'`);
  await h.admin(`INSERT INTO ai_usage_ledger (workspace_id, user_id, run_id, kind, model, tokens, input_tokens, output_tokens) VALUES ($1, $2, $3, 'usage', 'gpt-5.4-mini-2026-03-17', 0, 1000000, 0)`, [wsA, owner.id, runId]);
  const mini = (await h.admin(`SELECT cost_usd FROM ai_usage_ledger WHERE model = 'gpt-5.4-mini-2026-03-17'`))[0];
  check(mini.cost_usd === null, 'a snapshot id is priced by its own model (gpt-5.4-mini), not a shorter prefix (gpt-5.4)');

  // Bulk model change
  await h.user(owner, `SELECT ai_update_settings($1, '{"allowed_models":["claude-opus-5-5","claude-sonnet-5-5"],"default_model":"claude-opus-5-5"}')`, [wsA]);
  check(await h.denied(h.user(member, `SELECT ai_apply_model_to_agents($1, 'claude-sonnet-5-5')`, [wsA])), 'members cannot switch agent models');
  check(await h.denied(h.user(other, `SELECT ai_apply_model_to_agents($1, 'claude-sonnet-5-5')`, [wsA])), 'another workspace\'s owner cannot switch them');
  check(await h.denied(h.user(owner, `SELECT ai_apply_model_to_agents($1, 'gpt-5.4')`, [wsA])), 'models outside the allowed list are refused');
  const n = (await h.user(owner, `SELECT ai_apply_model_to_agents($1, 'claude-sonnet-5-5') AS n`, [wsA]))[0].n;
  const after = await h.admin(`SELECT DISTINCT v.model FROM workspace_agents a JOIN workspace_agent_versions v ON v.id = a.current_version_id WHERE a.workspace_id = $1 AND a.archived_at IS NULL`, [wsA]);
  check(n >= 16 && after.length === 1 && after[0].model === 'claude-sonnet-5-5', `admin switched ${n} agents to Sonnet 5.5`);
  const bModels = await h.admin(`SELECT DISTINCT v.model FROM workspace_agents a JOIN workspace_agent_versions v ON v.id = a.current_version_id WHERE a.workspace_id = $1`, [wsB]);
  check(!bModels.some((r) => r.model === 'claude-sonnet-5-5'), 'workspace B agents are unaffected');

  // Roster
  const handles = (await h.admin(`SELECT handle FROM workspace_agents WHERE workspace_id = $1 AND is_builtin AND archived_at IS NULL ORDER BY handle`, [wsB])).map((r) => r.handle);
  check(['gemini', 'kai', 'nova', 'vera', 'scribe', 'team'].every((x) => handles.includes(x)) && handles.length === 18, `roster: Gemini assistant + 16 specialists + team lead (${handles.join(', ')})`);

  // Automation keys
  check(await h.denied(h.user(member, `SELECT automation_key_create($1, 'n8n')`, [wsA])), 'members cannot create automation keys');
  check(await h.denied(h.user(other, `SELECT automation_key_create($1, 'n8n')`, [wsA])), 'other workspaces cannot create keys here');
  const key = (await h.user(owner, `SELECT automation_key_create($1, 'n8n production') AS r`, [wsA]))[0].r;
  check(/^[0-9a-f]{64}$/.test(key.secret), 'key secret is 256-bit hex, returned once');
  check(await h.denied(h.user(owner, 'SELECT secret FROM automation_keys')), 'clients cannot read stored secrets');
  const listed = await h.user(owner, 'SELECT * FROM automation_keys_list($1)', [wsA]);
  check(listed.length === 1 && !('secret' in listed[0]), 'key list omits secrets');
  check(await h.denied(h.user(other, 'SELECT * FROM automation_keys_list($1)', [wsA])), 'other workspaces cannot list keys');
  check(await h.denied(h.user(owner, 'SELECT automation_key_for($1)', [key.id])), 'signature material is server-only');
  const req = `req-${randomUUID()}`;
  const first = (await h.svc(`SELECT automation_start_run($1, $2, 'vera', 'Research our market', NULL) AS r`, [key.id, req]))[0].r;
  const again = (await h.svc(`SELECT automation_start_run($1, $2, 'vera', 'Research our market', NULL) AS r`, [key.id, req]))[0].r;
  check(first.run_id && again.run_id === first.run_id && again.reused === true, 'repeating a request id returns the same run (no duplicate execution)');
  const r = (await h.admin('SELECT requested_by, trigger, workspace_id FROM agent_runs WHERE id = $1', [first.run_id]))[0];
  check(r.requested_by === owner.id && r.trigger === 'automation' && r.workspace_id === wsA, 'automation runs act as the key owner in the key\'s workspace');
  await h.admin(`INSERT INTO workspace_agents (workspace_id, name, handle, is_builtin) VALUES ($1, 'B only', 'bonly-agent', false)`, [wsB]);
  check(await h.denied(h.svc(`SELECT automation_start_run($1, $2, 'bonly-agent', 'x', NULL)`, [key.id, `req-${randomUUID()}`])), 'a key cannot reach agents of another workspace');
  check((await h.user(owner, 'SELECT id FROM automation_requests')).length >= 1, 'admins see their execution log');
  check((await h.user(member, 'SELECT id FROM automation_requests')).length === 0, 'members do not see the execution log');
  check((await h.user(other, 'SELECT id FROM automation_requests')).length === 0, 'other workspaces do not see the execution log');
  const cb = (await h.svc('SELECT automation_callback_for_run($1) AS r', [first.run_id]))[0].r;
  check(cb.request_key === req && cb.status === 'accepted', 'finished runs find their automation request');
  await h.svc(`SELECT automation_record_delivery($1, 'no_callback')`, [cb.request_id]);
  check((await h.admin('SELECT status FROM automation_requests WHERE id = $1', [cb.request_id]))[0].status === 'no_callback', 'delivery outcome is recorded');
  check(await h.denied(h.user(other, 'SELECT automation_key_revoke($1)', [key.id]), /not found/), 'other workspaces cannot revoke the key');
  await h.user(owner, 'SELECT automation_key_revoke($1)', [key.id]);
  check(await h.denied(h.svc(`SELECT automation_start_run($1, $2, 'vera', 'x', NULL)`, [key.id, `req-${randomUUID()}`])), 'revoked keys stop working');
  const adm = await h.createUser('temp-admin');
  await h.admin(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [wsA, adm.id]);
  const k2 = (await h.user(adm, `SELECT automation_key_create($1, 'temp') AS r`, [wsA]))[0].r;
  await h.admin('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [wsA, adm.id]);
  check((await h.svc('SELECT automation_key_for($1) AS r', [k2.id]))[0].r.active === false, 'a key is inactive once its owner leaves the workspace');
  check(await h.denied(h.svc(`SELECT automation_start_run($1, $2, 'vera', 'x', NULL)`, [k2.id, `req-${randomUUID()}`])), 'and cannot start runs');

  // Project managers and task requests (20261024000100)
  const approver = async (u) => (await h.user(u, 'SELECT is_task_approver($1, $2) AS a', [wsA, u.id]))[0].a;
  check((await approver(owner)) && !(await approver(member)), 'without project managers, owners and admins approve tasks');
  check(await h.denied(h.user(member, 'SELECT set_project_manager($1, $2, true)', [wsA, member.id]), /owners and admins/), 'members cannot make themselves project managers');
  check(await h.denied(h.user(owner, 'SELECT set_project_manager($1, $2, true)', [wsA, other.id]), /not a member/), 'only workspace members can be project managers');
  await h.user(owner, 'SELECT set_project_manager($1, $2, true)', [wsA, member.id]);
  check((await approver(member)) && !(await approver(owner)), 'once chosen, only project managers approve tasks');
  const scribe = (await h.admin(`SELECT id FROM workspace_agents WHERE workspace_id = $1 AND template_key = 'note_taker'`, [wsA]))[0]?.id;
  check(Boolean(scribe), 'every workspace gets Scribe');
  const startScribe = async (u, scope = {}, trigger = 'interactive') => {
    const started = (await h.svc(`SELECT agent_start_run($1, $2, $3, NULL, 'Extract the tasks', $4, $5, '{}', '{"type":"private"}', $6, 1000) AS r`,
      [u.id, wsA, scribe, scope, trigger, randomUUID()]))[0].r;
    await h.svc(`SELECT agent_claim_run($1, 'smoke-worker')`, [started.run_id]);
    return started.run_id;
  };
  const submitRun = await startScribe(owner);
  const tasksJson = JSON.stringify([{ title: 'Send the Q3 report', assignee_ids: [owner.id], priority: 'high' }, { title: 'Book the venue' }]);
  const sub = (await h.svc(`SELECT agent_submit_task_requests($1, 'tool-1', $2, '#general') AS r`, [submitRun, tasksJson]))[0].r;
  check(sub.new === 2 && sub.approvers === 1, 'Scribe submits task requests to the project managers');
  const again2 = (await h.svc(`SELECT agent_submit_task_requests($1, 'tool-1', $2, '#general') AS r`, [submitRun, tasksJson]))[0].r;
  check(again2.new === 0 && again2.request_ids[0] === sub.request_ids[0], 'a retried submission does not duplicate requests');
  check((await h.admin(`SELECT count(*)::int AS n FROM tasks WHERE workspace_id = $1 AND title = 'Send the Q3 report'`, [wsA]))[0].n === 0, 'nothing is created before approval');
  const pmNote = await h.admin(`SELECT title, link FROM notifications WHERE user_id = $1 AND type = 'task_approval'`, [member.id]);
  check(pmNote.length === 1 && pmNote[0].link === '/tasks?view=approvals', 'project managers are notified of the requests');
  check((await h.user(member, 'SELECT id FROM task_requests')).length === 2, 'project managers see pending requests');
  check((await h.user(owner, 'SELECT id FROM task_requests')).length === 2, 'the submitter sees their requests');
  check((await h.user(other, 'SELECT id FROM task_requests')).length === 0, 'other workspaces see no requests');
  check(await h.denied(h.user(owner, 'SELECT decide_task_request($1, true)', [sub.request_ids[0]]), /not found/), 'non-approvers cannot approve');
  check(await h.denied(h.user(member, `INSERT INTO task_requests (workspace_id, title, submitted_by, idempotency_key) VALUES ($1, 'x', $2, 'k')`, [wsA, member.id])), 'clients cannot write task requests directly');
  const approved = (await h.user(member, `SELECT decide_task_request($1, true, '{"title":"Send the Q3 report to the board"}') AS r`, [sub.request_ids[0]]))[0].r;
  const task = (await h.admin('SELECT title, priority, created_by FROM tasks WHERE id = $1', [approved.task_id]))[0];
  check(approved.status === 'approved' && task?.title === 'Send the Q3 report to the board' && task.priority === 'high' && task.created_by === member.id,
    'approval creates the task with the manager\'s edits');
  const assigned = await h.admin(`SELECT link FROM notifications WHERE user_id = $1 AND type = 'task_assigned'`, [owner.id]);
  check(assigned.length === 1 && assigned[0].link === `/tasks/${approved.task_id}`, 'the assignee gets an assignment notification');
  const twice = (await h.user(member, 'SELECT decide_task_request($1, true) AS r', [sub.request_ids[0]]))[0].r;
  check(twice.status === 'approved' && twice.task_id === approved.task_id, 'approving twice does not create a second task');
  await h.user(member, `SELECT decide_task_request($1, false, '{}', 'Already booked')`, [sub.request_ids[1]]);
  const declined = await h.admin(`SELECT message FROM notifications WHERE user_id = $1 AND title LIKE 'Task not approved:%'`, [owner.id]);
  check(declined[0]?.message === 'Already booked', 'the submitter learns why a request was declined');
  await h.admin(`INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES ($1, $2, $2)`, [approved.task_id, member.id]);
  check((await h.admin(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'task_assigned'`, [member.id]))[0].n === 0, 'self-assignment does not notify');

  // Web Push queueing
  check(await h.denied(h.user(member, `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, 'https://push.example/x', $2, 'abcdefghijklmnop')`, [member.id, 'B'.repeat(87)])), 'clients cannot write push subscriptions directly');
  await h.admin(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, 'https://push.example/member', $2, 'abcdefghijklmnop')`, [member.id, 'B'.repeat(87)]);
  check((await h.user(other, 'SELECT id FROM push_subscriptions')).length === 0 && (await h.user(member, 'SELECT id FROM push_subscriptions')).length === 1, 'people see only their own push subscriptions');
  const t2 = (await h.admin(`INSERT INTO tasks (workspace_id, title, created_by) VALUES ($1, 'Pushed task', $2) RETURNING id`, [wsA, owner.id]))[0].id;
  await h.admin(`INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES ($1, $2, $3)`, [t2, member.id, owner.id]);
  const pushJobs = await h.admin(`SELECT payload FROM jobs WHERE kind = 'notification.push' AND principal_id = $1`, [member.id]);
  check(pushJobs.length >= 1, 'assignments to people with push enabled queue a push delivery');
  check((await h.admin(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'notification.push' AND principal_id = $1`, [owner.id]))[0].n === 0, 'people without push subscriptions queue nothing');

  // AI sessions in direct conversations
  const conv = (await h.user(owner, 'SELECT create_direct_conversation($1, $2, $3) AS c', [wsA, owner.id, member.id]))[0].c;
  const dm = (await h.admin('SELECT channel_id FROM direct_conversations WHERE id = $1', [conv]))[0].channel_id;
  const general = (await h.admin(`SELECT id FROM channels WHERE workspace_id = $1 AND id NOT IN (SELECT channel_id FROM direct_conversations) LIMIT 1`, [wsA]))[0]?.id;
  if (general) check(await h.denied(h.svc('SELECT ai_session_start($1, $2, $3)', [owner.id, general, scribe]), /not found/), 'sessions are only for direct conversations');
  check(await h.denied(h.svc('SELECT ai_session_start($1, $2, $3)', [other.id, dm, scribe]), /not found/), 'non-participants cannot start a session');
  await h.admin(`INSERT INTO messages (channel_id, user_id, content, created_at) VALUES ($1, $2, 'Before the session', now() - interval '1 hour')`, [dm, owner.id]);
  const session = (await h.svc('SELECT (ai_session_start($1, $2, $3)).*', [owner.id, dm, scribe]))[0];
  const sameSession = (await h.svc('SELECT (ai_session_start($1, $2, $3)).*', [member.id, dm, scribe]))[0];
  check(session.status === 'active' && sameSession.id === session.id, 'one active session per conversation');
  await h.admin(`INSERT INTO messages (channel_id, user_id, content, created_at) VALUES ($1, $2, 'Can you send the deck by Friday?', now() + interval '1 second')`, [dm, member.id]);
  check((await h.user(member, 'SELECT id FROM conversation_ai_sessions')).length === 1 && (await h.user(other, 'SELECT id FROM conversation_ai_sessions')).length === 0, 'participants see the session; others do not');
  check(await h.denied(h.svc('SELECT ai_session_finish($1, $2)', [other.id, session.id]), /not found/), 'non-participants cannot finish a session');
  const ended = (await h.svc('SELECT (ai_session_finish($1, $2)).*', [member.id, session.id]))[0];
  check(ended.status === 'finished' && ended.ended_by === member.id, 'either participant can finish the session');
  await h.admin(`UPDATE conversation_ai_sessions SET ended_at = now() + interval '1 minute' WHERE id = $1`, [session.id]);
  const transcript = await h.svc('SELECT content FROM ai_session_transcript_for($1, $2)', [owner.id, session.id]);
  check(transcript.length === 1 && transcript[0].content.startsWith('Can you send'), 'the agent reads only messages sent during the session');
  check((await h.svc('SELECT content FROM ai_session_transcript_for($1, $2)', [other.id, session.id])).length === 0, 'non-participants get no transcript');
  const notesRun = await startScribe(member, { channel_id: dm, session_id: session.id }, 'session_notes');
  check(Boolean(notesRun), 'session-notes runs can start');

  // @all announcements (20261025000200)
  const generalA = (await h.admin(`SELECT id FROM channels WHERE workspace_id = $1 AND slug = 'general'`, [wsA]))[0]?.id;
  check(Boolean(generalA), 'the workspace has a General channel');
  const ann = (await h.admin(`INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'Standup moved to 10:00 @all') RETURNING id`, [generalA, owner.id]))[0].id;
  check(await h.denied(h.user(member, 'SELECT notify_channel_everyone($1)', [ann]), /not found/), 'only the author can notify everyone');
  const sent = (await h.user(owner, 'SELECT notify_channel_everyone($1) AS n', [ann]))[0].n;
  const got = await h.admin(`SELECT id, user_id, link FROM notifications WHERE type = 'announcement' AND entity_id = $1`, [ann]);
  check(sent >= 1 && got.length === sent && !got.some((n) => n.user_id === owner.id), `@all notifies every other member of General (${sent})`);
  check((await h.user(owner, 'SELECT notify_channel_everyone($1) AS n', [ann]))[0].n === 0, '@all fires once per message');
  check((await h.admin(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'notification.push' AND payload->>'notification_id' = $1`, [got.find((n) => n.user_id === member.id)?.id ?? '00000000-0000-0000-0000-000000000000']))[0].n === 1, 'announcements are pushed to members with push enabled');
  const elsewhere = (await h.admin(`INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'hey @all') RETURNING id`, [dm, owner.id]))[0].id;
  check(await h.denied(h.user(owner, 'SELECT notify_channel_everyone($1)', [elsewhere]), /General/), '@all only works in General');

  // CRM company folders (20261025000300)
  const company = (await h.user(owner, `INSERT INTO crm_companies (workspace_id, name, owner_id, created_by) VALUES ($1, 'Acme Corp', $2, $3) RETURNING id, drive_folder_id`, [wsA, member.id, owner.id]))[0];
  const setup = (await h.admin(`SELECT c.drive_folder_id, c.brand_task_id, f.name AS folder, p.name AS parent, t.title,
      (SELECT array_agg(user_id) FROM task_assignees WHERE task_id = c.brand_task_id) AS assignees
    FROM crm_companies c JOIN drive_items f ON f.id = c.drive_folder_id LEFT JOIN drive_items p ON p.id = f.parent_id
    LEFT JOIN tasks t ON t.id = c.brand_task_id WHERE c.id = $1`, [company.id]))[0];
  check(setup?.folder === 'Acme Corp' && setup.parent === 'Companies', 'a new company gets a Drive folder inside Companies');
  check(setup?.title === 'Add logo and brand identity files for Acme Corp' && setup.assignees?.includes(member.id), 'and a brand-files task for the company owner');
  check((await h.admin(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'task_assigned' AND entity_id = $2`, [member.id, setup?.brand_task_id]))[0].n === 1, 'the owner is notified of the task');
  check((await h.user(member, `SELECT id FROM drive_items WHERE id = $1`, [setup?.drive_folder_id])).length === 1, 'workspace members can open the company folder');
  check((await h.admin(`SELECT count(*)::int AS n FROM crm_links WHERE company_id = $1`, [company.id]))[0].n === 2, 'the folder and task are linked to the company');
  await h.user(owner, `INSERT INTO crm_companies (workspace_id, name, owner_id, created_by) VALUES ($1, 'Globex', $2, $2)`, [wsA, owner.id]);
  check((await h.admin(`SELECT count(*)::int AS n FROM drive_items WHERE workspace_id = $1 AND name = 'Companies' AND parent_id IS NULL`, [wsA]))[0].n === 1, 'all companies share one Companies folder');

  // Client CRMs (20261026000100)
  await h.user(owner, 'UPDATE crm_companies SET is_client = true WHERE id = $1', [company.id]);
  const foldersBefore = (await h.admin(`SELECT count(*)::int AS n FROM drive_items WHERE workspace_id = $1 AND kind = 'folder'`, [wsA]))[0].n;
  const clientCo = (await h.user(owner, `INSERT INTO crm_companies (workspace_id, name, owner_id, created_by, client_id) VALUES ($1, 'Acme supplier', $2, $2, $3) RETURNING id, drive_folder_id`, [wsA, owner.id, company.id]))[0];
  const foldersAfter = (await h.admin(`SELECT count(*)::int AS n FROM drive_items WHERE workspace_id = $1 AND kind = 'folder'`, [wsA]))[0].n;
  check(clientCo.drive_folder_id === null && foldersAfter === foldersBefore, 'companies inside a client CRM get no Drive folder or task');
  const ourCo = (await h.admin(`SELECT id FROM crm_companies WHERE workspace_id = $1 AND name = 'Globex'`, [wsA]))[0].id;
  check(await h.denied(h.user(owner, `INSERT INTO crm_contacts (workspace_id, name, owner_id, created_by, client_id, company_id) VALUES ($1, 'Mixed', $2, $2, $3, $4)`, [wsA, owner.id, company.id, ourCo]), /different CRM/), 'records cannot link across CRMs');
  await h.user(owner, `INSERT INTO crm_contacts (workspace_id, name, owner_id, created_by, client_id, company_id) VALUES ($1, 'Jane at supplier', $2, $2, $3, $4)`, [wsA, owner.id, company.id, clientCo.id]);
  check((await h.user(member, 'SELECT id FROM crm_contacts WHERE client_id = $1', [company.id])).length === 1, 'a client CRM keeps its own contacts');
  check(await h.denied(h.user(owner, `INSERT INTO crm_companies (workspace_id, name, owner_id, created_by, client_id) VALUES ($1, 'Nope', $2, $2, $3)`, [wsA, owner.id, ourCo]), /client CRM/), 'only companies marked as clients have a CRM');
  check(await h.denied(h.user(owner, 'UPDATE crm_companies SET is_client = false WHERE id = $1', [company.id]), /still has records/), 'a client CRM with records cannot be removed');

  // CRM workspace (20261026000400)
  const pipeline = (await h.user(owner, `SELECT crm_create_pipeline($1, 'Sales', ARRAY['New','Proposal','Won','Lost']) AS id`, [wsA]))[0].id;
  const stages = await h.admin('SELECT id, name, is_won, is_lost, color FROM crm_stages WHERE pipeline_id = $1 ORDER BY position', [pipeline]);
  check(stages.find((s) => s.name === 'Won')?.is_won && stages.find((s) => s.name === 'Lost')?.is_lost, 'won and lost stages are recognised');
  check(await h.denied(h.user(member, `SELECT crm_save_stage($1, $2, NULL, 'Sneaky', 'sky')`, [wsA, pipeline])), 'members cannot change pipeline stages');
  const extra = (await h.user(owner, `SELECT crm_save_stage($1, $2, NULL, 'Demo', 'teal') AS id`, [wsA, pipeline]))[0].id;
  const wonCo = (await h.user(owner, `INSERT INTO crm_companies (workspace_id, name, owner_id, created_by) VALUES ($1, 'Initech', $2, $2) RETURNING id`, [wsA, owner.id]))[0].id;
  const deal = (await h.user(owner, `INSERT INTO crm_deals (workspace_id, name, owner_id, created_by, pipeline_id, stage_id, company_id) VALUES ($1, 'Initech rollout', $2, $2, $3, $4, $5) RETURNING id`, [wsA, owner.id, pipeline, extra, wonCo]))[0].id;
  check(await h.denied(h.user(owner, 'SELECT crm_delete_stage($1, $2, NULL)', [wsA, extra]), /another stage/), 'a stage with deals needs somewhere to move them');
  await h.user(owner, 'UPDATE crm_deals SET stage_id = $1 WHERE id = $2', [stages.find((s) => s.name === 'Won').id, deal]);
  check((await h.admin('SELECT customer_since FROM crm_companies WHERE id = $1', [wonCo]))[0].customer_since !== null, 'winning a deal makes its company a customer');
  await h.user(owner, 'SELECT crm_delete_stage($1, $2, NULL)', [wsA, extra]);
  await h.user(member, `INSERT INTO crm_notes (workspace_id, record_type, record_id, body, author_id) VALUES ($1, 'crm_deals', $2, 'Called, sending proposal', $3)`, [wsA, deal, member.id]);
  check((await h.user(owner, 'SELECT id FROM crm_notes WHERE record_id = $1', [deal])).length === 1, 'members share notes on records');
  check(await h.denied(h.user(member, `INSERT INTO crm_notes (workspace_id, record_type, record_id, body, author_id) VALUES ($1, 'crm_deals', $2, 'Forged', $3)`, [wsA, deal, owner.id]), /row-level security/), 'notes cannot be written as someone else');
  check((await h.user(other, 'SELECT id FROM crm_notes WHERE record_id = $1', [deal])).length === 0, 'outsiders cannot read CRM notes');
  check(await h.denied(h.user(member, `INSERT INTO crm_custom_fields (workspace_id, entity, key, label, field_type, created_by) VALUES ($1, 'companies', 'tier', 'Tier', 'select', $2)`, [wsA, member.id]), /row-level security/), 'only admins define custom properties');
  await h.user(owner, `INSERT INTO crm_custom_fields (workspace_id, entity, key, label, field_type, options, created_by) VALUES ($1, 'companies', 'tier', 'Tier', 'select', '{"choices":["Gold","Silver"]}', $2)`, [wsA, owner.id]);
  await h.user(owner, `UPDATE crm_companies SET custom = '{"tier":"Gold"}' WHERE id = $1`, [wonCo]);
  check((await h.user(member, `SELECT id FROM crm_companies WHERE workspace_id = $1 AND custom->>'tier' = 'Gold'`, [wsA])).length === 1, 'records filter by custom property values');
  await h.user(member, `INSERT INTO crm_views (workspace_id, entity, name, filters, created_by) VALUES ($1, 'companies', 'Gold customers', '[{"field":"custom.tier","op":"is","value":["Gold"]}]', $2)`, [wsA, member.id]);
  check((await h.user(owner, 'SELECT id FROM crm_views WHERE workspace_id = $1', [wsA])).length === 1, 'saved views are shared with the workspace');
  await h.user(owner, 'DELETE FROM crm_deals WHERE id = $1', [deal]);
  check((await h.admin('SELECT id FROM crm_notes WHERE record_id = $1', [deal])).length === 0, 'notes go with their record');

  // CRM import (20261026000500)
  const foldersBeforeImport = (await h.admin(`SELECT count(*)::int AS n FROM drive_items WHERE workspace_id = $1 AND kind = 'folder'`, [wsA]))[0].n;
  const imported = (await h.user(member, 'SELECT crm_import($1, $2, $3, $4) AS r', [wsA, company.id, 'companies', JSON.stringify([{ name: 'Supplier One', industry: 'Logistics' }, { name: 'supplier one' }, { name: '' }, { name: 'Supplier Two', custom: { tier: 'Gold' } }])]))[0].r;
  check(imported.created === 2 && imported.skipped === 2, 'imports skip duplicate and unnamed companies');
  const people = (await h.user(member, 'SELECT crm_import($1, $2, $3, $4) AS r', [wsA, company.id, 'contacts', JSON.stringify([{ name: 'Dana', email: 'dana@supplier.test', company: 'Supplier One' }, { name: 'Dana again', email: 'DANA@supplier.test' }, { name: 'Eli', company: 'Brand New Co' }])]))[0].r;
  check(people.created === 2 && people.skipped === 1 && people.companies_created === 1, 'contact imports dedupe by email and create missing companies');
  check((await h.admin(`SELECT c.client_id = $2 AS ok FROM crm_contacts ct JOIN crm_companies c ON c.id = ct.company_id WHERE ct.email = 'dana@supplier.test' AND ct.workspace_id = $1`, [wsA, company.id]))[0]?.ok, 'imported contacts link to companies in the same CRM');
  await h.user(owner, 'SELECT crm_import($1, NULL, $2, $3)', [wsA, 'companies', JSON.stringify([{ name: 'Bulk Our Co' }])]);
  check((await h.admin(`SELECT count(*)::int AS n FROM drive_items WHERE workspace_id = $1 AND kind = 'folder'`, [wsA]))[0].n === foldersBeforeImport, 'bulk imports into our CRM skip folders unless asked');
  await h.user(owner, 'SELECT crm_import($1, NULL, $2, $3, true)', [wsA, 'companies', JSON.stringify([{ name: 'Bulk With Folder' }])]);
  check((await h.admin(`SELECT drive_folder_id FROM crm_companies WHERE workspace_id = $1 AND name = 'Bulk With Folder'`, [wsA]))[0].drive_folder_id !== null, 'imports can still create folders when asked');
  check(await h.denied(h.user(other, 'SELECT crm_import($1, NULL, $2, $3)', [wsA, 'companies', '[]'])), 'outsiders cannot import');

  // Prospect columns (20261026000600)
  await h.user(owner, 'SELECT crm_import($1, NULL, $2, $3)', [wsA, 'companies', JSON.stringify([{ name: 'Consstar Construct', email: 'office@consstar.ro', industry: 'Construction', linkedin_url: 'https://www.linkedin.com/company/consstar', listed_location: 'Sector 5, Bucharest', prospect_type: 'Potential direct buyer', contact_status: 'Email and phone found', contact_sources: 'https://consstar.ro/contact' }])]);
  const pc = (await h.admin(`SELECT * FROM crm_companies WHERE workspace_id = $1 AND name = 'Consstar Construct'`, [wsA]))[0];
  check(pc?.has_linkedin === true && pc.prospect_type === 'Potential direct buyer' && pc.contact_sources === 'https://consstar.ro/contact', 'companies keep the prospect-list columns');

  // Social (20261026000700)
  const managed = (await h.user(owner, `INSERT INTO crm_companies (workspace_id, name, owner_id, created_by) VALUES ($1, 'Managed Brand', $2, $2) RETURNING id`, [wsA, owner.id]))[0].id;
  check(await h.denied(h.user(member, `INSERT INTO social_accounts (workspace_id, company_id, platform, label, created_by) VALUES ($1, $2, 'x', '@brand', $3)`, [wsA, managed, member.id]), /row-level security/), 'only admins connect social accounts');
  const acct = (await h.user(owner, `INSERT INTO social_accounts (workspace_id, company_id, platform, label, created_by, status) VALUES ($1, $2, 'linkedin', 'Managed Brand page', $3, 'connected') RETURNING id, status`, [wsA, managed, owner.id]))[0];
  check(acct.status === 'needs_login', 'new accounts start without a login');
  check(await h.denied(h.user(owner, `INSERT INTO social_accounts (workspace_id, company_id, platform, label, created_by) VALUES ($1, $2, 'x', 'Client book co', $3)`, [wsA, clientCo.id, owner.id]), /our CRM/), 'social accounts belong to our own CRM companies');
  check(await h.denied(h.user(owner, 'SELECT * FROM social_account_sessions')), 'clients cannot read social sessions');
  const later = new Date(Date.now() + 3600e3).toISOString();
  const postId = (await h.user(member, 'SELECT social_schedule_post($1, $2, $3, NULL, $4, $5) AS id', [wsA, managed, 'Launch day!', [acct.id], later]))[0].id;
  check((await h.admin(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'social.publish' AND payload->>'target_id' IN (SELECT id::text FROM social_post_targets WHERE post_id = $1)`, [postId]))[0].n === 1, 'scheduling queues one publish per account');
  check((await h.user(other, 'SELECT id FROM social_posts WHERE id = $1', [postId])).length === 0, 'outsiders cannot see social posts');
  check(await h.denied(h.user(member, 'SELECT social_schedule_post($1, NULL, $2, NULL, $3)', [wsA, 'Wrong brand', [acct.id]]), /accounts of this company/), 'posts only go to the chosen company’s accounts');
  await h.user(member, 'SELECT social_cancel_post($1)', [postId]);
  check((await h.admin('SELECT status FROM social_posts WHERE id = $1', [postId]))[0].status === 'cancelled', 'cancelled posts stop');
  await h.admin(`INSERT INTO workspace_member_features (workspace_id, hidden) VALUES ($1, '{social}') ON CONFLICT (workspace_id) DO UPDATE SET hidden = '{social}'`, [wsA]);
  check((await h.user(member, 'SELECT id FROM social_posts WHERE workspace_id = $1', [wsA])).length === 0, 'hiding Social hides it from the team');
  await h.admin(`UPDATE workspace_member_features SET hidden = '{}' WHERE workspace_id = $1`, [wsA]);

  // CRM delete (20261026000300)
  const doomed = (await h.user(owner, `INSERT INTO crm_companies (workspace_id, name, owner_id, created_by) VALUES ($1, 'Short-lived Ltd', $2, $2) RETURNING id`, [wsA, owner.id]))[0].id;
  const keptContact = (await h.user(owner, `INSERT INTO crm_contacts (workspace_id, name, owner_id, created_by, company_id) VALUES ($1, 'Kept person', $2, $2, $3) RETURNING id`, [wsA, owner.id, doomed]))[0].id;
  await h.user(member, 'DELETE FROM crm_companies WHERE id = $1', [doomed]);
  check((await h.admin('SELECT id FROM crm_companies WHERE id = $1', [doomed])).length === 1, 'members cannot delete CRM companies');
  await h.user(owner, 'DELETE FROM crm_companies WHERE id = $1', [doomed]);
  check((await h.admin('SELECT id FROM crm_companies WHERE id = $1', [doomed])).length === 0, 'admins can delete CRM companies');
  check((await h.admin('SELECT company_id FROM crm_contacts WHERE id = $1', [keptContact]))[0]?.company_id === null, 'a deleted company leaves its contacts, unlinked');
  check(await h.denied(h.user(owner, 'DELETE FROM crm_companies WHERE id = $1', [company.id]), /still has records/), 'a client company with its own records cannot be deleted');

  // Receipts and direct-message push (20261026000200)
  const dmMsg = (await h.admin(`INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, 'Are you around?') RETURNING id, created_at`, [dm, owner.id]))[0];
  check((await h.admin(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'message.push' AND principal_id = $1 AND payload->>'message_id' = $2`, [member.id, dmMsg.id]))[0].n === 1, 'direct messages are pushed to the other participant');
  check((await h.admin(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'message.push' AND principal_id = $1 AND payload->>'message_id' = $2`, [owner.id, dmMsg.id]))[0].n === 0, 'senders get no push for their own message');
  await h.user(member, 'SELECT mark_channel_seen($1, $2, false)', [dm, dmMsg.created_at]);
  let seen = (await h.user(owner, 'SELECT * FROM channel_receipts($1)', [dm])).find((r) => r.user_id === member.id);
  check(seen && new Date(seen.last_delivered_at) >= new Date(dmMsg.created_at) && new Date(seen.last_read_at) < new Date(dmMsg.created_at), 'a received message shows as delivered, not read');
  await h.user(member, 'SELECT mark_channel_seen($1, $2, true)', [dm, dmMsg.created_at]);
  seen = (await h.user(owner, 'SELECT * FROM channel_receipts($1)', [dm])).find((r) => r.user_id === member.id);
  check(new Date(seen.last_read_at) >= new Date(dmMsg.created_at), 'an opened conversation shows as read');
  check((await h.user(other, 'SELECT * FROM channel_receipts($1)', [dm])).length === 0, 'outsiders cannot see receipts');
  await h.admin(`INSERT INTO messages (channel_id, user_id, content, created_at) VALUES ($1, $2, 'One more thing', now() + interval '2 seconds')`, [dm, owner.id]);
  const before = (await h.admin('SELECT last_delivered_at FROM channel_members WHERE channel_id = $1 AND user_id = $2', [dm, member.id]))[0].last_delivered_at;
  check((await h.user(member, 'SELECT mark_all_delivered() AS n'))[0].n >= 1 && (await h.admin('SELECT last_delivered_at FROM channel_members WHERE channel_id = $1 AND user_id = $2', [dm, member.id]))[0].last_delivered_at > before, 'a running app marks new messages delivered');

  // Member features (20261025000400)
  check(await h.denied(h.user(member, `SELECT set_member_features($1, ARRAY['ai'])`, [wsA]), /owners and admins/), 'members cannot change features');
  check(await h.denied(h.user(owner, `SELECT set_member_features($1, ARRAY['games'])`, [wsA])), 'unknown features are refused');
  await h.user(owner, `SELECT set_member_features($1, ARRAY['ai','crm'])`, [wsA]);
  const vis = async (u, f) => (await h.user(u, 'SELECT feature_visible_to($1, $2, $3) AS v', [wsA, u.id, f]))[0].v;
  check(!(await vis(member, 'ai')) && (await vis(owner, 'ai')) && (await vis(member, 'drive')), 'hidden features stay visible to admins only');
  check(await h.denied(h.svc(`SELECT agent_start_run($1, $2, $3, NULL, 'hi', '{}', 'interactive', '{}', '{"type":"private"}', $4, 1000)`, [member.id, wsA, scribe, randomUUID()]), /not available/), 'members cannot run agents while AI is hidden');
  check(Boolean(await startScribe(owner)), 'admins still can');
  await h.user(owner, `SELECT set_member_features($1, '{}')`, [wsA]);
  check(await vis(member, 'ai'), 'showing AI again restores access');

  // Dashboard insights (20261025000100)
  const done = (await h.admin(`INSERT INTO tasks (workspace_id, title, created_by, status) VALUES ($1, 'Shipped it', $2, 'completed') RETURNING id`, [wsA, owner.id]))[0].id;
  await h.admin(`INSERT INTO task_activity (task_id, user_id, action, details) VALUES ($1, $2, 'status_changed', '{"status":"completed"}')`, [done, owner.id]);
  const insights = (await h.user(owner, 'SELECT workspace_dashboard_insights($1) AS r', [wsA]))[0].r;
  const thisWeek = insights.throughput.at(-1);
  check(insights.throughput.length === 8 && thisWeek.opened >= 1 && thisWeek.completed >= 1, `dashboard throughput covers 8 weeks and counts this week (opened ${thisWeek.opened}, completed ${thisWeek.completed})`);
  check((await h.user(other, 'SELECT workspace_dashboard_insights($1) AS r', [wsA]))[0]?.r == null, 'other workspaces get no dashboard insights');

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll smoke checks passed');
  process.exit(failures ? 1 : 0);
}
