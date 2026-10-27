import { z } from 'zod';
import { rpc } from '../../database.js';
import { defineTool, quoteData } from './types.js';
const record = z.object({kind:z.enum(['contacts','companies','deals']),record_id:z.string().uuid()});
interface CrmSearchRow {
 id:string; kind:'contacts'|'companies'|'deals'; name:string; detail:string; updated_at:string;
}
export const searchCrm=defineTool({
 name:'search_crm',description:'Search the whole workspace CRM across contacts, companies and deals. Returns only records in the requester\'s workspace.',
 schema:z.object({query:z.string().max(200).optional(),kind:z.enum(['contacts','companies','deals']).optional(),limit:z.number().int().min(1).max(50).optional()}),label:(input)=> input.query?`Searching CRM for “${input.query}”`:'Listing CRM records',
 async run(ctx,input){
  const rows=await rpc<CrmSearchRow[]>('crm_search_for',{p_actor:ctx.actorId,p_workspace_id:ctx.workspaceId,p_query:input.query??null,p_kind:input.kind??null,p_limit:input.limit??20});
  for(const row of rows) await ctx.recordSource('crm_record',row.id,{label:row.name});
  return{content:rows.length?rows.map((row)=>quoteData('crm_record',{kind:row.kind,record_id:row.id,link:`/crm/${row.kind}/${row.id}`,updated_at:row.updated_at},`${row.name}\n${row.detail}`)).join('\n\n'):'No matching CRM records.',summary:{results:rows.length,kinds:[...new Set(rows.map((row)=>row.kind))]}};
 }
});
export const readCrmRecord=defineTool({
 name:'read_crm_record',description:'Read one workspace CRM contact, company or deal by its ID. CRM records are shared within the workspace. It does not grant access to linked resources.',schema:record,label:()=> 'Reading CRM record',
 async run(ctx,input){const data=await rpc<Record<string,unknown>>('crm_read_for',{p_actor:ctx.actorId,p_workspace_id:ctx.workspaceId,p_kind:input.kind,p_record_id:input.record_id});await ctx.recordSource('crm_record',input.record_id,{label:String(data.name)});return{content:quoteData('crm_record',{link:`/crm/${input.kind}/${input.record_id}`},JSON.stringify(data)),summary:{record_id:input.record_id,kind:input.kind}};}
});
export const proposeCrmUpdate=defineTool({
 name:'propose_crm_update',description:'Propose a reviewed CRM name, notes, lifecycle or deal stage change. Never sends email. Uses the exact record ID and kind.',
 schema:record.extend({changes:z.object({name:z.string().min(1).max(200).optional(),notes:z.string().max(20000).optional(),lifecycle_stage:z.enum(['lead','qualified','customer','former_customer']).optional(),stage_id:z.string().uuid().optional()}).refine(v=>Object.keys(v).length>0)}),label:()=> 'Preparing CRM changes for review',
 async run(ctx,input,call){const data=await rpc<Record<string,unknown>>('crm_read_for',{p_actor:ctx.actorId,p_workspace_id:ctx.workspaceId,p_kind:input.kind,p_record_id:input.record_id});await ctx.recordSource('crm_record',input.record_id,{label:String(data.name)});const summary=`Update ${data.name}: ${Object.keys(input.changes).join(', ')}`;const p=await rpc<{status:string;proposal_id?:string;reason?:string}>('agent_create_proposal',{p_run_id:ctx.runId,p_tool_use_id:call.toolUseId,p_action_type:'update_crm_record',p_arguments:input,p_summary:summary});return{content:p.status==='proposed'?'Changes await review; nothing has been changed.':p.reason??'The audience cannot access the sources.',summary:{record_id:input.record_id,status:p.status},status:p.status==='proposed'?'proposed':'denied',...(p.proposal_id?{proposal:{id:p.proposal_id,action_type:'update_crm_record',summary,status:'pending'}}:{})};}
});
