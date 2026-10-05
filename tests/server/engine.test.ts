// Deterministic provider double exercises real persistence, retrieval and approval SQL.
// This is NOT evidence of a live Anthropic request.
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { ENV_FILE } from '../../tools/local-supabase/lib.ts';
import { createUser,createWorkspace,q,admin,pool,type TestUser } from '../helpers/db.ts';
import { executeRun } from '../../server/agents/engine.js';
import { startRun } from '../../server/agents/start.js';
import { drainQueue } from '../../server/jobs/runner.js';
import { emptyUsage,type ModelProvider,type TurnResult } from '../../server/ai/provider.js';
import { POST as runEndpoint } from '../../api/agents/run.js';
import { GET as jobEndpoint } from '../../api/jobs/run.js';
let user:TestUser;let ws:string,agent:string,doc:string;
beforeAll(async()=>{loadEnvFile(ENV_FILE);user=await createUser('engine');ws=await createWorkspace(user);agent=(await admin("SELECT id FROM workspace_agents WHERE workspace_id=$1 AND template_key='knowledge_assistant'",[ws]))[0].id;doc=(await q(user,"SELECT (drive_create_document($1,NULL,'Travel policy','The approved travel budget is EUR 180 per night.')).id AS id",[ws]))[0].id;await admin("UPDATE jobs SET run_after=now() WHERE workspace_id=$1 AND kind='knowledge.extract'",[ws]);await drainQueue({worker:'test-engine',workspaceId:ws,deadline:Date.now()+20000});});
afterAll(()=>pool.end());
describe('agent engine through real database and PostgREST',()=>{
 it('denies unauthenticated model calls and cron invocations',async()=>{expect((await runEndpoint(new Request('http://localhost/api/agents/run',{method:'POST',body:'{}'}))).status).toBe(401);expect((await jobEndpoint(new Request('http://localhost/api/jobs/run'))).status).toBe(401);});
 it('persists a missing-provider failure honestly',async()=>{const run=await startRun(user.id,{workspace_id:ws,agent_id:agent,message:'Hello',idempotency_key:randomUUID()});await executeRun(run.run_id,{provider:{name:'unconfigured-test',configured:()=>false,startSession:()=>{throw new Error('Must not generate');}}});const row=(await q(user,'SELECT status,error_code FROM agent_runs WHERE id=$1',[run.run_id]))[0];expect(row.status).toBe('failed');expect(row.error_code).toBe('provider_not_configured');});
 it('retrieves an authorized document, persists a review card, and saves once after approval',async()=>{
  let step=0;const outputs:string[]=[];
  const provider:ModelProvider={name:'test-double',configured:()=>true,startSession:()=>({addToolResults:(results)=>outputs.push(...results.map(r=>r.content)),next:async():Promise<TurnResult>=>{step++;return{text:step===3?'The policy allows EUR 180 per night [1]. A summary is ready for your review.':'',stop:step<3?'tool_use':'end',toolCalls:step===1?[{id:'read-1',name:'read_file',input:{item_id:doc}}]:step===2?[{id:'save-1',name:'propose_document',input:{title:'Travel summary',body:'Travel budget: EUR 180 per night.'}}]:[],refusalCategory:null,usage:emptyUsage(),model:'test-double',fallbackUsed:false,webSearches:[],webSources:[]};}})};
  const started=await startRun(user.id,{workspace_id:ws,agent_id:agent,message:'Read the selected policy and propose a summary.',scope:{item_ids:[doc]},idempotency_key:randomUUID()});
  await executeRun(started.run_id,{provider});
  expect(outputs.join('\n')).toContain('180');
  const proposals=await q(user,'SELECT id,arguments_hash FROM agent_action_proposals WHERE run_id=$1',[started.run_id]);expect(proposals).toHaveLength(1);expect(await q(user,'SELECT id FROM agent_citations WHERE run_id=$1',[started.run_id])).toHaveLength(1);
  const [p]=proposals;const first=(await q(user,'SELECT agent_decide_proposal($1,true,$2) AS r',[p.id,p.arguments_hash]))[0].r;expect(first.status).toBe('executed');const again=(await q(user,'SELECT agent_decide_proposal($1,true,$2) AS r',[p.id,p.arguments_hash]))[0].r;expect(again.result.item_id).toBe(first.result.item_id);
  expect((await q(user,'SELECT name FROM drive_items WHERE id=$1',[first.result.item_id]))[0].name).toBe('Travel summary');
 });
});
