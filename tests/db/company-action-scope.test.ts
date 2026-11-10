import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  asService,
  createUser,
  createWorkspace,
  expectDenied,
  pool,
  q,
  type TestUser,
} from '../helpers/db.ts';

let owner: TestUser;
let workspace: string;
let companyA: string;
let companyB: string;
let folderA: string;
let folderB: string;
let documentA: string;
let documentA2: string;
let documentB: string;
let runId: string;

const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  asService(async (client) => (await client.query(sql, params)).rows as T[]);

beforeAll(async () => {
  owner = await createUser('company-scope-owner');
  workspace = await createWorkspace(owner, 'Company write scope');
  [companyA] = (await q<{ id: string }>(owner, `
    INSERT INTO crm_companies (
      workspace_id, name, domain, owner_id, created_by, is_client
    ) VALUES ($1, 'Company A', 'a.example', $2, $2, true)
    RETURNING id
  `, [workspace, owner.id])).map((row) => row.id);
  [companyB] = (await q<{ id: string }>(owner, `
    INSERT INTO crm_companies (
      workspace_id, name, domain, owner_id, created_by, is_client
    ) VALUES ($1, 'Company B', 'b.example', $2, $2, true)
    RETURNING id
  `, [workspace, owner.id])).map((row) => row.id);
  [{ drive_folder_id: folderA }, { drive_folder_id: folderB }] = await admin<{
    id: string;
    drive_folder_id: string;
  }>(`
    SELECT id, drive_folder_id
    FROM crm_companies
    WHERE id = ANY($1::uuid[])
    ORDER BY CASE id WHEN $2 THEN 0 ELSE 1 END
  `, [[companyA, companyB], companyA]);
  [documentA] = (await q<{ id: string }>(owner,
    `SELECT id FROM drive_create_document($1, $2, 'A brief', 'A evidence')`,
    [workspace, folderA])).map((row) => row.id);
  [documentA2] = (await q<{ id: string }>(owner,
    `SELECT id FROM drive_create_document($1, $2, 'A older brief', 'More A evidence')`,
    [workspace, folderA])).map((row) => row.id);
  [documentB] = (await q<{ id: string }>(owner,
    `SELECT id FROM drive_create_document($1, $2, 'B brief', 'B evidence')`,
    [workspace, folderB])).map((row) => row.id);

  const [agent] = await admin<{ id: string }>(`
    SELECT id FROM workspace_agents
    WHERE workspace_id = $1 AND template_key = 'cerebras_coordinator'
  `, [workspace]);
  const [started] = await svc<{ run: { run_id: string } }>(`
    SELECT agent_start_run(
      $1, $2, $3, NULL, 'Scoped writes', $4,
      'interactive', '{}', '{"type":"private"}', $5, 1000
    ) AS run
  `, [owner.id, workspace, agent.id, JSON.stringify({ company_id: companyA }), randomUUID()]);
  runId = started.run.run_id;
  await svc('SELECT agent_claim_run($1, $2)', [runId, 'company-action-test']);
});
afterAll(() => pool.end());

describe('managed-company Drive and retrieval boundaries', () => {
  it('filters exact selected sources in SQL before Drive LIMIT', async () => {
    const selected = await svc<{ id: string }>(`
      SELECT id FROM agent_list_company_drive_for(
        $1, $2, $3, NULL, NULL, 1, $4
      )
    `, [owner.id, workspace, companyA, [documentA2]]);
    expect(selected).toEqual([{ id: documentA2 }]);

    const metadata = await svc<{ id: string }>(`
      SELECT id FROM agent_scope_items_scoped_for($1, $2, $3, $4)
      ORDER BY id
    `, [owner.id, workspace, companyA, [documentA, documentB]]);
    expect(metadata.map((row) => row.id)).toEqual([documentA]);
  });

  it('rejects Drive destinations outside the run company', async () => {
    await expectDenied(svc(
      `SELECT agent_create_proposal($1, 'cross-drive', 'save_document', $2, 'Save elsewhere')`,
      [runId, { title: 'Wrong folder', body: 'No', folder_id: folderB }],
    ), /selected managed company|inside the selected/i);
    await expectDenied(svc(
      `SELECT agent_create_proposal($1, 'root-drive', 'save_document', $2, 'Save to root')`,
      [runId, { title: 'No folder', body: 'No', folder_id: null }],
    ), /folder inside the selected managed company/i);
  });

  it('rejects a task project linked to another managed company', async () => {
    const [project] = await admin<{ id: string }>(`
      INSERT INTO projects (workspace_id, name, owner_id, visibility)
      VALUES ($1, 'Company B project', $2, 'workspace') RETURNING id
    `, [workspace, owner.id]);
    const [task] = await admin<{ id: string }>(`
      INSERT INTO tasks (workspace_id, project_id, title, created_by)
      VALUES ($1, $2, 'Company B task', $3) RETURNING id
    `, [workspace, project.id, owner.id]);
    await q(owner, `
      INSERT INTO crm_links (workspace_id, company_id, task_id, created_by)
      VALUES ($1, $2, $3, $4)
    `, [workspace, companyB, task.id, owner.id]);
    await expectDenied(svc(
      `SELECT agent_create_proposal($1, 'cross-project', 'create_task', $2, 'Wrong project')`,
      [runId, {
        title: 'Wrong project', description: null, priority: 'medium',
        due_date: null, project_id: project.id, assignee_ids: [], source_channel_id: null,
      }],
    ), /project is outside the selected managed company/i);
  });
});

describe('managed-company reviewed writes', () => {
  it('forces Social drafts to the run company', async () => {
    const [created] = await svc<{ proposal: { proposal_id: string } }>(`
      SELECT agent_create_proposal(
        $1, 'social', 'create_social_drafts', $2, 'Create a Social draft'
      ) AS proposal
    `, [runId, { posts: [{ body: 'Company A update', company_id: companyB }] }]);
    const [proposal] = await admin<{ arguments_hash: string; arguments: { posts: Array<{ company_id: string }> } }>(
      'SELECT arguments_hash, arguments FROM agent_action_proposals WHERE id = $1',
      [created.proposal.proposal_id],
    );
    expect(proposal.arguments.posts[0].company_id).toBe(companyA);
    const [decision] = await q<{ result: { status: string; result: { post_ids: string[] } } }>(owner,
      'SELECT agent_decide_proposal($1, true, $2) AS result',
      [created.proposal.proposal_id, proposal.arguments_hash]);
    expect(decision.result.status).toBe('executed');
    const posts = await admin<{ company_id: string }>(
      'SELECT company_id FROM social_posts WHERE id = ANY($1::uuid[])',
      [decision.result.result.post_ids],
    );
    expect(posts).toEqual([{ company_id: companyA }]);
  });

  it('links a directly approved task to the run company transactionally', async () => {
    const [created] = await svc<{ proposal: { proposal_id: string } }>(`
      SELECT agent_create_proposal(
        $1, 'task', 'create_task', $2, 'Create scoped task'
      ) AS proposal
    `, [runId, {
      title: 'Scoped direct task', description: null, priority: 'medium',
      due_date: null, project_id: null, assignee_ids: [], source_channel_id: null,
    }]);
    const [proposal] = await admin<{ arguments_hash: string; arguments: { company_id: string } }>(
      'SELECT arguments_hash, arguments FROM agent_action_proposals WHERE id = $1',
      [created.proposal.proposal_id],
    );
    expect(proposal.arguments.company_id).toBe(companyA);
    const [decision] = await q<{ result: { status: string; result: { task_id: string } } }>(owner,
      'SELECT agent_decide_proposal($1, true, $2) AS result',
      [created.proposal.proposal_id, proposal.arguments_hash]);
    expect(decision.result.status).toBe('executed');
    expect(await admin(
      'SELECT id FROM crm_links WHERE company_id = $1 AND task_id = $2',
      [companyA, decision.result.result.task_id],
    )).toHaveLength(1);
  });

  it('persists and links manager-approved task requests to the run company', async () => {
    const [submitted] = await svc<{ result: { request_ids: string[]; company_id: string } }>(`
      SELECT agent_submit_task_requests($1, 'manager-task', $2, NULL) AS result
    `, [runId, JSON.stringify([{
      title: 'Manager-reviewed task', description: null, priority: 'high',
      due_date: null, project_id: null, assignee_ids: [],
    }])]);
    expect(submitted.result.company_id).toBe(companyA);
    const [request] = await admin<{ company_id: string }>(
      'SELECT company_id FROM task_requests WHERE id = $1',
      [submitted.result.request_ids[0]],
    );
    expect(request.company_id).toBe(companyA);
    const [decision] = await q<{ result: { status: string; task_id: string } }>(owner,
      `SELECT decide_task_request($1, true, '{}'::jsonb, NULL) AS result`,
      [submitted.result.request_ids[0]]);
    expect(decision.result.status).toBe('approved');
    expect(await admin(
      'SELECT id FROM crm_links WHERE company_id = $1 AND task_id = $2',
      [companyA, decision.result.task_id],
    )).toHaveLength(1);
  });
});
