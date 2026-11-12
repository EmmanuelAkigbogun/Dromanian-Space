// Deterministic provider double exercises real persistence, retrieval and approval SQL.
// This is NOT evidence of a live Anthropic request.
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { ENV_FILE } from '../../tools/local-database/lib.ts';
import { createUser,createWorkspace,addMember,q,admin,pool,type TestUser } from '../helpers/db.ts';
import { executeRun } from '../../server/agents/engine.js';
import { startRun } from '../../server/agents/start.js';
import { drainQueue } from '../../server/jobs/runner.js';
import { emptyUsage,type ModelProvider,type TurnResult } from '../../server/ai/provider.js';
import { POST as runEndpoint } from '../../api/agents/run.js';
import { GET as jobEndpoint } from '../../api/jobs/run.js';
let user:TestUser;let ws:string,agent:string,doc:string;
beforeAll(async()=>{loadEnvFile(ENV_FILE);user=await createUser('engine');ws=await createWorkspace(user);agent=(await admin("SELECT id FROM workspace_agents WHERE workspace_id=$1 AND template_key='github_customer_support'",[ws]))[0].id;doc=(await q(user,"SELECT (drive_create_document($1,NULL,'Travel policy','The approved travel budget is EUR 180 per night.')).id AS id",[ws]))[0].id;await admin("UPDATE jobs SET run_after=now() WHERE workspace_id=$1 AND kind='knowledge.extract'",[ws]);await drainQueue({worker:'test-engine',workspaceId:ws,deadline:Date.now()+20000});});
afterAll(()=>pool.end());
describe('agent engine through real database and PostgREST',()=>{
 it('denies unauthenticated model calls and cron invocations',async()=>{expect((await runEndpoint(new Request('http://localhost/api/agents/run',{method:'POST',body:'{}'}))).status).toBe(401);expect((await jobEndpoint(new Request('http://localhost/api/jobs/run'))).status).toBe(401);});
 it('persists a missing-provider failure honestly',async()=>{const run=await startRun(user.id,{workspace_id:ws,agent_id:agent,message:'Hello',idempotency_key:randomUUID()});await executeRun(run.run_id,{provider:{name:'unconfigured-test',configured:()=>false,startSession:()=>{throw new Error('Must not generate');}}});const row=(await q(user,'SELECT status,error_code FROM agent_runs WHERE id=$1',[run.run_id]))[0];expect(row.status).toBe('failed');expect(row.error_code).toBe('provider_not_configured');});
 it('fails a claimed session run before the model when conversation access was revoked',async()=>{
  const member=await createUser('revoked-session-member');
  await addMember(ws,member);
  const conversation=(await q<{id:string}>(user,'SELECT create_direct_conversation($1,$2,$3) AS id',[ws,user.id,member.id]))[0].id;
  const channel=(await admin<{channel_id:string}>('SELECT channel_id FROM direct_conversations WHERE id=$1',[conversation]))[0].channel_id;
  const noteAgent=(await admin<{id:string}>("SELECT id FROM workspace_agents WHERE workspace_id=$1 AND template_key='cerebras_writer'",[ws]))[0].id;
  const session=(await admin<{id:string}>('SELECT (ai_session_start($1,$2,$3)).id',[user.id,channel,noteAgent]))[0];
  await admin('SELECT ai_session_request_review($1,$2)',[user.id,session.id]);
  const queued=(await admin<{review_run_id:string}>("SELECT (ai_session_start_run($1,$2,'review','Review this conversation',1000)).review_run_id",[user.id,session.id]))[0];
  await admin('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channel,user.id]);
  let modelCalled=false;
  const outcome=await executeRun(queued.review_run_id,{
   provider:{name:'configured-test',configured:()=>true,startSession:()=>{throw new Error('Must not generate');}},
   agentRunner:{run:async()=>{modelCalled=true;throw new Error('Must not generate');}},
  });
  const row=(await admin<{status:string;error_code:string}>('SELECT status,error_code FROM agent_runs WHERE id=$1',[queued.review_run_id]))[0];
  expect(modelCalled).toBe(false);
  expect(outcome).toMatchObject({status:'failed',error_code:'membership_removed'});
  expect(row).toMatchObject({status:'failed',error_code:'membership_removed'});
 });
 it('does not publish final session prose using a prior attempt task outcome',async()=>{
  const member=await createUser('session-outcome-member');
  await addMember(ws,member);
  const conversation=(await q<{id:string}>(user,'SELECT create_direct_conversation($1,$2,$3) AS id',[ws,user.id,member.id]))[0].id;
  const channel=(await admin<{channel_id:string}>('SELECT channel_id FROM direct_conversations WHERE id=$1',[conversation]))[0].channel_id;
  const noteAgent=(await admin<{id:string}>("SELECT id FROM workspace_agents WHERE workspace_id=$1 AND template_key='cerebras_writer'",[ws]))[0].id;
  const session=(await admin<{id:string}>('SELECT (ai_session_start($1,$2,$3)).id',[user.id,channel,noteAgent]))[0];
  await admin("INSERT INTO messages(channel_id,user_id,content) VALUES($1,$2,'Please prepare the launch checklist.')",[channel,user.id]);
  await admin('SELECT ai_session_request_review($1,$2)',[user.id,session.id]);
  const review=(await admin<{review_run_id:string}>("SELECT (ai_session_start_run($1,$2,'review','Review this conversation',1000)).review_run_id",[user.id,session.id]))[0];
  await admin("SELECT agent_claim_run($1,'review-worker')",[review.review_run_id]);
  await admin("SELECT agent_finish_run($1,'review-worker','completed','Review complete',NULL,NULL,NULL)",[review.review_run_id]);
  await admin('SELECT ai_session_request_finish($1,$2)',[user.id,session.id]);
  const first=(await admin<{notes_run_id:string}>("SELECT (ai_session_start_run($1,$2,'final','Write final notes',1000)).notes_run_id",[user.id,session.id]))[0];
  const firstOutcome=await executeRun(first.notes_run_id,{
   provider:{name:'configured-test',configured:()=>true,startSession:()=>{throw new Error('Agent runner is supplied');}},
   agentRunner:{run:async(_input,callbacks)=>{
    await callbacks.callTool({id:'empty-outcome',name:'submit_tasks_for_approval',input:{tasks:[]}});
    throw new Error('Provider failed after persisting the task outcome');
   }},
  });
  expect(firstOutcome).toMatchObject({status:'failed',error_code:'internal'});
  expect((await admin<{run_id:string}>('SELECT run_id FROM ai_session_task_submissions WHERE session_id=$1',[session.id]))[0].run_id).toBe(first.notes_run_id);
  await admin('SELECT ai_session_request_finish($1,$2)',[user.id,session.id]);
  const retry=(await admin<{notes_run_id:string}>("SELECT (ai_session_start_run($1,$2,'final','Retry final notes',1000)).notes_run_id",[user.id,session.id]))[0];
  const outcome=await executeRun(retry.notes_run_id,{
   provider:{name:'configured-test',configured:()=>true,startSession:()=>{throw new Error('Agent runner is supplied');}},
   agentRunner:{run:async()=>({text:'Retry prose without this run persisting its own task outcome.',usage:emptyUsage(),model:'test-double'})},
  });
  const row=(await admin<{status:string;error_code:string}>('SELECT status,error_code FROM agent_runs WHERE id=$1',[retry.notes_run_id]))[0];
  const published=await admin('SELECT id FROM messages WHERE agent_run_id=$1',[retry.notes_run_id]);
  expect(outcome).toMatchObject({status:'failed',error_code:'internal'});
  expect(row).toMatchObject({status:'failed',error_code:'internal'});
  expect(published).toHaveLength(0);
 });
 it('retrieves an authorized document, persists a review card, and saves once after approval',async()=>{
  let step=0;const outputs:string[]=[];
  const provider:ModelProvider={name:'openai',configured:()=>true,startSession:()=>({addToolResults:(results)=>outputs.push(...results.map(r=>r.content)),next:async():Promise<TurnResult>=>{step++;return{text:step===3?'The policy allows EUR 180 per night [1]. A summary is ready for your review.':'',stop:step<3?'tool_use':'end',toolCalls:step===1?[{id:'read-1',name:'read_file',input:{item_id:doc}}]:step===2?[{id:'save-1',name:'propose_document',input:{title:'Travel summary',body:'Travel budget: EUR 180 per night.'}}]:[],refusalCategory:null,usage:emptyUsage(),model:'test-double',fallbackUsed:false,webSearches:[],webSources:[]};}})};
  const started=await startRun(user.id,{workspace_id:ws,agent_id:agent,message:'Read the selected policy and propose a summary.',scope:{item_ids:[doc]},idempotency_key:randomUUID()});
  await executeRun(started.run_id,{provider});
  expect(outputs.join('\n')).toContain('180');
  const proposals=await q(user,'SELECT id,arguments_hash FROM agent_action_proposals WHERE run_id=$1',[started.run_id]);expect(proposals).toHaveLength(1);expect(await q(user,'SELECT id FROM agent_citations WHERE run_id=$1',[started.run_id])).toHaveLength(1);
  const [p]=proposals;const first=(await q(user,'SELECT agent_decide_proposal($1,true,$2) AS r',[p.id,p.arguments_hash]))[0].r;expect(first.status).toBe('executed');const again=(await q(user,'SELECT agent_decide_proposal($1,true,$2) AS r',[p.id,p.arguments_hash]))[0].r;expect(again.result.item_id).toBe(first.result.item_id);
  expect((await q(user,'SELECT name FROM drive_items WHERE id=$1',[first.result.item_id]))[0].name).toBe('Travel summary');
 });
});
