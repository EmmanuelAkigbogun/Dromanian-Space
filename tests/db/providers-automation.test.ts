/**
 * Provider catalog, cost estimation, bulk model changes, the expanded roster
 * and signed automation (n8n) at the SQL boundary, across two independent
 * workspaces. Server-only functions run as service_role, people as
 * `authenticated`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, admin, asService, asUser, createUser, createWorkspace, expectDenied, pool, q, type TestUser } from '../helpers/db.ts';

let owner: TestUser; // owner of workspace A
let member: TestUser; // plain member of A
let other: TestUser; // owner of workspace B
let wsA: string;
let wsB: string;

const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  asService(async (c) => (await c.query(sql, params)).rows as T[]);

beforeAll(async () => {
  [owner, member, other] = await Promise.all([createUser('p-owner'), createUser('p-member'), createUser('p-other')]);
  wsA = await createWorkspace(owner, 'Providers A');
  wsB = await createWorkspace(other, 'Providers B');
  await addMember(wsA, member);
});
afterAll(() => pool.end());

describe('model catalog and platform state', () => {
  it('lets members read the catalog but only the server report provider state', async () => {
    const models = await q<{ id: string; provider: string }>(member, 'SELECT id, provider FROM ai_models ORDER BY sort_order');
    expect(models.find((m) => m.id === 'claude-opus-5-5')?.provider).toBe('anthropic');
    expect(models.find((m) => m.id === 'gpt-5.4')?.provider).toBe('openai');
    expect(models.find((m) => m.id === 'gpt-oss-120b')?.provider).toBe('cerebras');
    await expectDenied(q(owner, `SELECT ai_report_platform('{"openai":true}', 'gpt-5.4')`));
    await expectDenied(q(owner, `UPDATE ai_models SET input_per_mtok = 0 WHERE id = 'claude-opus-5-5' RETURNING id`));
  });

  it('starts new workspaces on the reported default and keeps existing settings', async () => {
    // Platform state is global and other test files run in parallel: the whole
    // OpenAI-only scenario runs in one transaction that is always rolled back.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const as = async (role: string, claims: Record<string, unknown>, sql: string, params: unknown[] = []) => {
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        return (await client.query(sql, params)).rows;
      };
      const service = (sql: string, params: unknown[] = []) => as('service_role', { role: 'service_role' }, sql, params);
      const before = (await service('SELECT default_model FROM workspace_ai_settings WHERE workspace_id = $1', [wsA]))[0];
      await service(`SELECT ai_report_platform('{"anthropic":false,"openai":true}', 'gpt-5.4')`);
      const fresh = (await as('authenticated', { sub: other.id, role: 'authenticated', email: other.email },
        'SELECT create_workspace_with_owner($1, $2, $3, NULL) AS ws', ['Fresh', `fresh-${randomUUID().slice(0, 8)}`, other.id]))[0].ws.id;
      const s = (await service('SELECT (ai_settings_for($1)).*', [fresh]))[0];
      expect(s.default_model).toBe('gpt-5.4');
      expect(s.allowed_models).toContain('gpt-5.4');
      expect(s.allowed_models).toContain('gpt-oss-120b');
      // Built-ins keep their Cerebras model even when another platform default is reported.
      const seeded = await service(
        `SELECT DISTINCT v.model FROM workspace_agents a JOIN workspace_agent_versions v ON v.id = a.current_version_id WHERE a.workspace_id = $1`, [fresh]);
      expect(seeded.map((r) => r.model)).toEqual(['gpt-oss-120b']);
      const unchanged = (await service('SELECT default_model FROM workspace_ai_settings WHERE workspace_id = $1', [wsA]))[0];
      expect(unchanged?.default_model).toBe(before?.default_model);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects models from unsupported providers', async () => {
    await expectDenied(
      q(owner, `SELECT ai_update_settings($1, '{"allowed_models":["claude-opus-5-5","llama3"],"default_model":"claude-opus-5-5"}')`, [wsA]),
      /Anthropic|OpenAI/,
    );
  });
});

describe('usage costs', () => {
  it('estimates cost from catalog prices, sets the provider and never invents a price', async () => {
    const run = randomUUID();
    await admin(
      `INSERT INTO ai_usage_ledger (workspace_id, user_id, run_id, kind, model, tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ($1, $2, $3, 'usage', 'claude-opus-5-5', 0, 1000000, 100000, 1000000, 0),
              ($1, $2, $3, 'usage', 'gpt-5.4-2026-03-05', 0, 1000, 1000, 0, 0)`,
      [wsA, owner.id, run],
    );
    const rows = await admin<{ model: string; provider: string; cost_usd: string | null }>(
      'SELECT model, provider, cost_usd FROM ai_usage_ledger WHERE run_id = $1 ORDER BY model', [run]);
    // 1M input x $4 + 0.1M output x $20 + 1M cache reads x $0.20 = $6.20
    expect(rows.find((r) => r.model === 'claude-opus-5-5')).toMatchObject({ provider: 'anthropic', cost_usd: '6.200000' });
    // OpenAI prices are unknown until an administrator sets them.
    expect(rows.find((r) => r.model.startsWith('gpt'))).toMatchObject({ provider: 'openai', cost_usd: null });
    const summary = await svc<{ model: string; cost_usd: string | null; unpriced_rows: string }>('SELECT * FROM ai_cost_summary($1)', [wsA]);
    expect(summary.find((s) => s.model === 'claude-opus-5-5')?.cost_usd).toBe('6.200000');
    expect(Number(summary.find((s) => s.model.startsWith('gpt'))?.unpriced_rows)).toBe(1);
    await expectDenied(q(owner, 'SELECT * FROM ai_cost_summary($1)', [wsA]));
  });
});

describe('switching agent models', () => {
  it('lets admins move every shared agent to an allowed model with new versions', async () => {
    await q(owner, `SELECT ai_update_settings($1, '{"allowed_models":["claude-opus-5-5","claude-sonnet-5-5"],"default_model":"claude-opus-5-5"}')`, [wsA]);
    await expectDenied(q(member, `SELECT ai_apply_model_to_agents($1, 'claude-sonnet-5-5')`, [wsA]), /admins/);
    await expectDenied(q(other, `SELECT ai_apply_model_to_agents($1, 'claude-sonnet-5-5')`, [wsA]), /admins/);
    await expectDenied(q(owner, `SELECT ai_apply_model_to_agents($1, 'gpt-5.4')`, [wsA]), /not allowed/);
    const changed = (await q<{ n: number }>(owner, `SELECT ai_apply_model_to_agents($1, 'claude-sonnet-5-5') AS n`, [wsA]))[0].n;
    expect(changed).toBeGreaterThanOrEqual(5);
    const models = await admin<{ model: string }>(
      `SELECT v.model FROM workspace_agents a JOIN workspace_agent_versions v ON v.id = a.current_version_id
       WHERE a.workspace_id = $1 AND a.archived_at IS NULL`, [wsA]);
    expect(new Set(models.map((m) => m.model))).toEqual(new Set(['claude-sonnet-5-5']));
    const otherModels = await admin<{ model: string }>(
      `SELECT DISTINCT v.model FROM workspace_agents a JOIN workspace_agent_versions v ON v.id = a.current_version_id WHERE a.workspace_id = $1`, [wsB]);
    expect(otherModels.map((m) => m.model)).not.toContain('claude-sonnet-5-5');
  });
});

describe('Cerebras roster', () => {
  it('adds exactly the five Cerebras agents to every workspace', async () => {
    const rows = await admin<{ handle: string; job: string; tools: string[] }>(
      `SELECT a.handle, t.job, v.tools
       FROM workspace_agents a
       JOIN agent_templates t ON t.key = a.template_key
       JOIN workspace_agent_versions v ON v.id = a.current_version_id
       WHERE a.workspace_id = $1 AND a.is_builtin AND a.archived_at IS NULL ORDER BY a.handle`, [wsA]);
    expect(rows.map((r) => r.handle)).toEqual([
      'cerebras-analyst', 'cerebras-engineer', 'cerebras-research', 'cerebras-team', 'cerebras-writer']);
    expect(rows.every((r) => r.tools.length > 0)).toBe(true);
  });
});

describe('signed automation keys', () => {
  let keyA: { id: string; secret: string };

  it('lets only admins create keys and never exposes secrets to clients', async () => {
    await expectDenied(q(member, `SELECT automation_key_create($1, 'n8n')`, [wsA]), /admins/);
    await expectDenied(q(other, `SELECT automation_key_create($1, 'n8n')`, [wsA]), /admins/);
    keyA = (await q<{ r: { id: string; secret: string } }>(owner, `SELECT automation_key_create($1, 'n8n production') AS r`, [wsA]))[0].r;
    expect(keyA.secret).toMatch(/^[0-9a-f]{64}$/);
    await expectDenied(q(owner, 'SELECT secret FROM automation_keys'));
    const listed = await q<Record<string, unknown>>(owner, 'SELECT * FROM automation_keys_list($1)', [wsA]);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('secret');
    await expectDenied(q(other, 'SELECT * FROM automation_keys_list($1)', [wsA]), /admins/);
    await expectDenied(q(owner, 'SELECT automation_key_for($1)', [keyA.id]));
  });

  it('starts one run per request id and only with agents of the key\'s workspace', async () => {
    const requestId = `req-${randomUUID()}`;
    const first = (await svc<{ r: { run_id: string; reused: boolean } }>(
      `SELECT automation_start_run($1, $2, 'cerebras-research', 'Research our market', NULL) AS r`, [keyA.id, requestId]))[0].r;
    const again = (await svc<{ r: { run_id: string; reused: boolean } }>(
      `SELECT automation_start_run($1, $2, 'cerebras-research', 'Research our market', NULL) AS r`, [keyA.id, requestId]))[0].r;
    expect(again.run_id).toBe(first.run_id);
    expect(again.reused).toBe(true);
    const run = (await admin<{ requested_by: string; trigger: string; workspace_id: string }>(
      'SELECT requested_by, trigger, workspace_id FROM agent_runs WHERE id = $1', [first.run_id]))[0];
    expect(run).toEqual({ requested_by: owner.id, trigger: 'automation', workspace_id: wsA });
    expect((await admin('SELECT id FROM agent_runs WHERE idempotency_key LIKE $1', [`automation:${keyA.id}:${requestId}`]))).toHaveLength(1);

    // A custom agent in workspace B with a unique handle is invisible to workspace A's key.
    await admin(`INSERT INTO workspace_agents (workspace_id, name, handle, is_builtin) VALUES ($1, 'B only', 'bonly-agent', false)`, [wsB]);
    await expectDenied(svc(`SELECT automation_start_run($1, $2, 'bonly-agent', 'x', NULL)`, [keyA.id, `req-${randomUUID()}`]), /cannot use/);
  });

  it('keeps the execution log per workspace and admin-only', async () => {
    expect((await q(owner, 'SELECT id FROM automation_requests')).length).toBeGreaterThanOrEqual(1);
    expect(await q(member, 'SELECT id FROM automation_requests')).toHaveLength(0);
    expect(await q(other, 'SELECT id FROM automation_requests')).toHaveLength(0);
  });

  it('stops working when revoked or when its owner leaves the workspace', async () => {
    await expectDenied(q(other, 'SELECT automation_key_revoke($1)', [keyA.id]));
    await q(owner, 'SELECT automation_key_revoke($1)', [keyA.id]);
    await expectDenied(svc(`SELECT automation_start_run($1, $2, 'cerebras-research', 'x', NULL)`, [keyA.id, `req-${randomUUID()}`]), /not active/);

    const adminUser = await createUser('p-admin');
    await addMember(wsA, adminUser, 'admin');
    const key = (await q<{ r: { id: string } }>(adminUser, `SELECT automation_key_create($1, 'temp') AS r`, [wsA]))[0].r;
    await admin('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [wsA, adminUser.id]);
    const state = (await svc<{ r: { active: boolean } }>('SELECT automation_key_for($1) AS r', [key.id]))[0].r;
    expect(state.active).toBe(false);
    await expectDenied(svc(`SELECT automation_start_run($1, $2, 'cerebras-research', 'x', NULL)`, [key.id, `req-${randomUUID()}`]), /member/);
  });

  it('is not callable anonymously', async () => {
    await expectDenied(asUser({ id: randomUUID(), email: 'x@example.test' }, (c) => c.query(`SELECT automation_key_create($1, 'x')`, [wsA])), /admins/);
  });
});
