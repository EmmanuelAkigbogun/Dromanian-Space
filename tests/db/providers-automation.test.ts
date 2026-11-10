/**
 * Provider catalog, cost estimation, bulk model changes, the expanded roster
 * and signed automation (n8n) at the SQL boundary, across two independent
 * workspaces. Server-only functions run as service_role, people as
 * `authenticated`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, admin, asService, asUser, createChannel, createUser, createWorkspace, expectDenied, pool, postMessage, q, type TestUser } from '../helpers/db.ts';

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
    expect(models.find((m) => m.id === 'gpt-6.1-sol')?.provider).toBe('openai');
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
      expect(s.allowed_models).toContain('gpt-6.1-sol');
      // Built-ins keep their ChatGPT model even when another platform default is reported.
      const seeded = await service(
        `SELECT DISTINCT v.model FROM workspace_agents a JOIN workspace_agent_versions v ON v.id = a.current_version_id WHERE a.workspace_id = $1`, [fresh]);
      expect(seeded.map((r) => r.model)).toEqual(['gpt-6.1-sol']);
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

  it('serializes concurrent configuration versions on the agent row', async () => {
    const [agent] = await admin<{ id: string; max_version: number }>(
      `SELECT a.id, max(v.version_no)::int AS max_version
       FROM workspace_agents a
       JOIN workspace_agent_versions v ON v.agent_id = a.id
       WHERE a.workspace_id = $1 AND a.handle = 'scout'
       GROUP BY a.id`, [wsA]);
    const save = async (instructions: string) => (await q<{ version_no: number }>(owner,
      'SELECT (agent_save_config($1, $2)).version_no AS version_no',
      [agent.id, JSON.stringify({ instructions })]))[0];
    const versions = await Promise.all([save('Concurrent configuration A'), save('Concurrent configuration B')]);
    expect(versions.map((version) => version.version_no).sort((a, b) => a - b))
      .toEqual([agent.max_version + 1, agent.max_version + 2]);
    const [current] = await admin<{ current_version: number; max_version: number }>(
      `SELECT current.version_no::int AS current_version,
              (SELECT max(version_no)::int FROM workspace_agent_versions WHERE agent_id = agent.id) AS max_version
       FROM workspace_agents agent
       JOIN workspace_agent_versions current ON current.id = agent.current_version_id
       WHERE agent.id = $1`, [agent.id]);
    expect(current.current_version).toBe(current.max_version);
  });
});

describe('managed-company agent boundaries', () => {
  it('returns only requester-visible Drive descendants and linked task/channel IDs', async () => {
    const [company] = await q<{ id: string }>(owner,
      `INSERT INTO crm_companies (workspace_id, name, domain, owner_id, created_by, is_client)
       VALUES ($1, $2, 'scope-a.example', $3, $3, true) RETURNING id`,
      [wsA, `Scoped company ${randomUUID().slice(0, 8)}`, owner.id]);
    const [record] = await admin<{ drive_folder_id: string }>(
      'SELECT drive_folder_id FROM crm_companies WHERE id = $1', [company.id]);
    const [descendant] = await q<{ id: string }>(owner,
      `SELECT id FROM drive_create_document($1, $2, 'Company brief', 'Scoped evidence')`,
      [wsA, record.drive_folder_id]);
    await admin(
      `INSERT INTO drive_items (
         workspace_id, parent_id, kind, name, owner_id, created_by, updated_by, origin
       )
       SELECT $1, $2, 'document', 'Scoped page ' || n, $3, $3, $3, 'document'
       FROM generate_series(1, 60) AS n`,
      [wsA, record.drive_folder_id, owner.id],
    );
    const [otherCompany] = await q<{ id: string }>(owner,
      `INSERT INTO crm_companies (workspace_id, name, domain, owner_id, created_by, is_client)
       VALUES ($1, $2, 'scope-b.example', $3, $3, true) RETURNING id`,
      [wsA, `Other scoped company ${randomUUID().slice(0, 8)}`, owner.id]);
    const [otherRecord] = await admin<{ drive_folder_id: string }>(
      'SELECT drive_folder_id FROM crm_companies WHERE id = $1', [otherCompany.id]);
    const [otherDescendant] = await q<{ id: string }>(owner,
      `SELECT id FROM drive_create_document($1, $2, 'Company brief outside scope', 'Unrelated evidence')`,
      [wsA, otherRecord.drive_folder_id]);
    const channel = await createChannel(owner, wsA, { name: `scope-${randomUUID().slice(0, 6)}`, members: [member] });
    const otherChannel = await createChannel(owner, wsA, { name: `other-${randomUUID().slice(0, 6)}`, members: [member] });
    const messageId = await postMessage(owner, channel, 'Scoped company conversation evidence');
    await postMessage(owner, otherChannel, 'Other company conversation evidence');
    const [project] = await admin<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, owner_id, visibility)
       VALUES ($1, 'Scoped company project', $2, 'workspace') RETURNING id`,
      [wsA, owner.id]);
    const [otherProject] = await admin<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, owner_id, visibility)
       VALUES ($1, 'Other company project', $2, 'workspace') RETURNING id`,
      [wsA, owner.id]);
    const [task] = await admin<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, title, created_by)
       VALUES ($1, $2, 'Scoped follow-up', $3) RETURNING id`,
      [wsA, project.id, member.id]);
    const [otherTask] = await admin<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, title, created_by)
       VALUES ($1, $2, 'Other follow-up', $3) RETURNING id`,
      [wsA, otherProject.id, member.id]);
    await q(owner,
      `INSERT INTO crm_links (workspace_id, company_id, task_id, created_by) VALUES ($1, $2, $3, $4)`,
      [wsA, company.id, task.id, owner.id]);
    await q(owner,
      `INSERT INTO crm_links (workspace_id, company_id, channel_id, created_by) VALUES ($1, $2, $3, $4)`,
      [wsA, company.id, channel, owner.id]);
    await q(owner,
      `INSERT INTO crm_links (workspace_id, company_id, task_id, created_by) VALUES ($1, $2, $3, $4)`,
      [wsA, otherCompany.id, otherTask.id, owner.id]);
    await q(owner,
      `INSERT INTO crm_links (workspace_id, company_id, channel_id, created_by) VALUES ($1, $2, $3, $4)`,
      [wsA, otherCompany.id, otherChannel, owner.id]);

    const [scope] = await svc<{ item_ids: string[]; task_ids: string[]; channel_ids: string[] }>(
      'SELECT * FROM agent_company_scope_ids($1, $2, $3)', [member.id, wsA, company.id]);
    expect(scope.item_ids).toEqual(expect.arrayContaining([record.drive_folder_id, descendant.id]));
    expect(scope.task_ids).toContain(task.id);
    expect(scope.channel_ids).toContain(channel);
    const companyItemIds = await svc<{ id: string }>(
      'SELECT id FROM agent_company_drive_item_ids_for($1, $2, $3)',
      [member.id, wsA, company.id]);
    expect(companyItemIds.map((item) => item.id)).toEqual(
      expect.arrayContaining([record.drive_folder_id, descendant.id]),
    );
    expect(companyItemIds).toHaveLength(62);
    expect(companyItemIds.map((item) => item.id)).not.toContain(otherDescendant.id);

    const listed = await svc<{ id: string; name: string }>(
      'SELECT id, name FROM agent_list_company_drive_for($1, $2, $3, $4, NULL, 100)',
      [member.id, wsA, company.id, 'Scoped page']);
    expect(listed).toHaveLength(60);
    expect(listed.every((item) => item.name.startsWith('Scoped page '))).toBe(true);
    expect(listed.map((item) => item.id)).not.toContain(otherDescendant.id);

    const selectedSearch = await svc<{ id: string; result_type: string }>(
      `SELECT id, result_type
       FROM agent_search_workspace_scoped_for($1, $2, 'Company brief', ARRAY['file'], 1, $3, $4)`,
      [member.id, wsA, company.id, [descendant.id]]);
    expect(selectedSearch).toEqual([{ id: descendant.id, result_type: 'file' }]);
    const taskSearch = await svc<{ id: string }>(
      `SELECT id
       FROM agent_search_workspace_scoped_for($1, $2, 'Scoped follow-up', ARRAY['task'], 10, $3, NULL)`,
      [member.id, wsA, company.id]);
    expect(taskSearch.map((result) => result.id)).toEqual([task.id]);
    const scopedTasks = await svc<{ id: string }>(
      'SELECT id FROM agent_list_tasks_scoped_for($1, $2, NULL, false, false, 100, $3)',
      [member.id, wsA, company.id]);
    expect(scopedTasks.map((result) => result.id)).toContain(task.id);
    expect(scopedTasks.map((result) => result.id)).not.toContain(otherTask.id);
    const scopedProjects = await svc<{ id: string }>(
      'SELECT id FROM agent_projects_scoped_for($1, $2, $3)',
      [member.id, wsA, company.id]);
    expect(scopedProjects.map((result) => result.id)).toEqual([project.id]);
    const scopedChannels = await svc<{ id: string }>(
      'SELECT id FROM agent_channels_scoped_for($1, $2, $3)',
      [member.id, wsA, company.id]);
    expect(scopedChannels.map((result) => result.id)).toEqual([channel]);
    const scopedMessages = await svc<{ id: string }>(
      'SELECT id FROM agent_read_conversation_scoped_for($1, $2, $3, NULL, 60, NULL, $4)',
      [member.id, wsA, channel, company.id]);
    expect(scopedMessages.map((result) => result.id)).toContain(messageId);
    await expectDenied(svc(
      'SELECT * FROM agent_read_conversation_scoped_for($1, $2, $3, NULL, 60, NULL, $4)',
      [member.id, wsA, otherChannel, company.id]), /Company conversation not found/);
    const unscopedKinds = await svc<{ result_type: string }>(
      `SELECT result_type
       FROM agent_search_workspace_scoped_for($1, $2, 'scout', ARRAY['person','agent'], 10, $3, NULL)`,
      [member.id, wsA, company.id]);
    expect(unscopedKinds).toEqual([]);

    await expectDenied(q(member, 'SELECT * FROM agent_company_scope_ids($1, $2, $3)', [member.id, wsA, company.id]));
    await expectDenied(q(member,
      'SELECT * FROM agent_company_drive_item_ids_for($1, $2, $3)',
      [member.id, wsA, company.id]));
    await expectDenied(q(member,
      'SELECT * FROM agent_list_company_drive_for($1, $2, $3, NULL, NULL, 20)',
      [member.id, wsA, company.id]));
    await expectDenied(q(member,
      `SELECT * FROM agent_search_workspace_scoped_for($1, $2, 'brief', NULL, 20, $3, NULL)`,
      [member.id, wsA, company.id]));
    await expectDenied(svc(
      'SELECT * FROM agent_list_company_drive_for($1, $2, $3, NULL, $4, 20)',
      [member.id, wsA, company.id, otherRecord.drive_folder_id]), /Company folder not found/);
    await expectDenied(svc('SELECT * FROM agent_company_scope_ids($1, $2, $3)', [other.id, wsA, company.id]), /Workspace not found/);

    const [agent] = await admin<{ id: string }>(
      `SELECT id FROM workspace_agents
       WHERE workspace_id = $1 AND handle = 'cerebras-team'`, [wsA]);
    const [started] = await svc<{ run: { run_id: string } }>(
      `SELECT agent_start_run($1, $2, $3, NULL, 'Company metrics', $4,
                              'interactive', '{}', '{"type":"private"}', $5, 1000) AS run`,
      [member.id, wsA, agent.id, JSON.stringify({ company_id: company.id }), randomUUID()]);
    await svc('SELECT agent_claim_run($1, $2)', [started.run.run_id, 'company-metrics-test']);
    const [metric] = await svc<{ result: { rows: Array<{ count: number | string }> } }>(
      `SELECT agent_workspace_metrics($1, 'tasks_by_status', NULL, NULL) AS result`,
      [started.run.run_id]);
    expect(metric.result.rows.reduce((sum, row) => sum + Number(row.count), 0)).toBe(1);
    await svc('SELECT agent_finish_run($1, NULL, $2, $3, NULL, NULL, NULL)',
      [started.run.run_id, 'completed', 'Metrics complete']);
  });

  it('replays only top-level turns from the same company scope', async () => {
    const companies = await Promise.all(['History A', 'History B'].map(async (name) =>
      (await q<{ id: string }>(owner,
        `INSERT INTO crm_companies (workspace_id, name, owner_id, created_by, is_client)
         VALUES ($1, $2, $3, $3, true) RETURNING id`,
        [wsA, `${name} ${randomUUID().slice(0, 8)}`, owner.id]))[0].id));
    const [agent] = await admin<{ id: string }>(
      `SELECT id FROM workspace_agents WHERE workspace_id = $1 AND handle = 'cerebras-team'`, [wsA]);
    const start = async (conversationId: string | null, content: string, companyId: string | null) =>
      (await svc<{ run: { run_id: string; conversation_id: string } }>(
        `SELECT agent_start_run($1, $2, $3, $4, $5, $6, 'interactive', '{}', '{"type":"private"}', $7, 1000) AS run`,
        [owner.id, wsA, agent.id, conversationId, content,
          JSON.stringify(companyId ? { company_id: companyId } : {}), randomUUID()]))[0].run;
    const finish = (runId: string, content: string) =>
      svc('SELECT agent_finish_run($1, NULL, $2, $3, NULL, NULL, NULL)', [runId, 'completed', content]);

    const firstA = await start(null, 'Question A', companies[0]);
    await finish(firstA.run_id, 'Answer A');
    const firstB = await start(firstA.conversation_id, 'Question B', companies[1]);
    await finish(firstB.run_id, 'Answer B');
    const portfolio = await start(firstA.conversation_id, 'Portfolio question', null);
    await finish(portfolio.run_id, 'Portfolio answer');
    const currentA = await start(firstA.conversation_id, 'Follow-up A', companies[0]);

    const history = await svc<{ role: string; content: string }>(
      'SELECT role, content FROM agent_history_for($1, 24)', [currentA.run_id]);
    expect(history.map((message) => message.content)).toEqual(['Question A', 'Answer A']);
    await expectDenied(q(owner, 'SELECT * FROM agent_history_for($1, 24)', [currentA.run_id]));
    await finish(currentA.run_id, 'Second answer A');
  });
});

describe('OpenAI multi-company roster', () => {
  it('adds all twenty agents and gives browser extraction only to web-research roles', async () => {
    const rows = await admin<{ handle: string; job: string; tools: string[]; model: string; requires: string[]; web_capable: boolean }>(
      `SELECT a.handle, t.job, v.tools, v.model, t.requires,
              ('web_search' = ANY(t.default_tools) OR 'fetch_site_page' = ANY(t.default_tools)) AS web_capable
       FROM workspace_agents a
       JOIN agent_templates t ON t.key = a.template_key
       JOIN workspace_agent_versions v ON v.id = a.current_version_id
       WHERE a.workspace_id = $1 AND a.is_builtin AND a.archived_at IS NULL ORDER BY a.handle`, [wsB]);
    expect(rows.map((r) => r.handle)).toEqual([
      'cerebras-analyst', 'cerebras-research', 'cerebras-team', 'cerebras-writer',
      'commerce-analyst', 'competitor-intelligence', 'creative-director', 'customer-success',
      'customer-support', 'drive-agent', 'email-marketing', 'executive-assistant',
      'finance-analyst', 'marketing-strategist', 'project-manager', 'recruiting-assistant',
      'sales-development', 'scout', 'seo-specialist', 'social-calendar',
    ]);
    expect(rows.every((r) => r.tools.length > 0)).toBe(true);
    expect(rows.every((r) => r.model === 'gpt-6.1-sol')).toBe(true);
    expect(rows.filter((r) => r.web_capable)).toHaveLength(7);
    expect(rows.filter((r) => r.web_capable).every((r) => r.tools.includes('browser_scrape'))).toBe(true);
    expect(rows.filter((r) => !r.web_capable).every((r) => !r.tools.includes('browser_scrape'))).toBe(true);
    expect(rows.find((r) => r.handle === 'seo-specialist')?.requires).not.toContain('site_url');
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
