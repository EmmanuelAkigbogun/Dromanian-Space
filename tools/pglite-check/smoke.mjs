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
    check(by.growth_strategist?.version_no === 2 && /marketing strategist/.test(by.growth_strategist.instructions), 'upgrade: untouched Atlas refocused as marketing strategist (new version)');
    check(by.recruiter?.version_no === 2 && /HR assistant/.test(by.recruiter.instructions), 'upgrade: untouched Talia broadened to HR assistant');
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
  check(['kai', 'nova', 'vera', 'team'].every((x) => handles.includes(x)) && handles.length === 16, `roster: 15 specialists + team lead (${handles.join(', ')})`);

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

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll smoke checks passed');
  process.exit(failures ? 1 : 0);
}
