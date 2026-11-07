import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {hash,validateReview} from '../../src/domain.js';
import {validateDialogFacts} from '../../src/ai/facts.js';
import {calculate} from '../../src/scoring.js';
import {Store} from '../../src/store.js';
const [directoryArg,id]=process.argv.slice(2);assert.ok(directoryArg&&id,'Pass store directory and run ID');
const directory=resolve(directoryArg),store=new Store(directory),run=JSON.parse(await readFile(join(directory,'runs',id+'.json'),'utf8'));
const pricing=JSON.parse(await readFile(new URL('./pricing.json',import.meta.url),'utf8'));
assert.equal(run.status,'completed');assert.equal(run.configuration_hash,hash(run.execution));
const results=[],distribution={},latencies=[],totals={completed:0,partial:0,failed:0,calls:0,prompt_tokens:0,completion_tokens:0};let quotes=0,ranges=0,cost=0,unknownCost=0;
for(const task of run.tasks){
 assert.ok(['completed','partial','failed'].includes(task.status)&&task.evaluation_id);
 const r=await store.read(task.evaluation_id);assert.equal(r.run_id,id);assert.equal(r.configuration_hash,run.configuration_hash);assert.deepEqual(r.execution_snapshot,run.execution);
 assert.equal(r.status,task.status);assert.equal(r.reference_hash,hash(r.reference_snapshot.text));assert.equal(r.reference_hash,run.execution.reference_hash);
 assert.equal(r.conversation_hash,hash(r.conversation));assert.deepEqual(r.conversation,task.conversation);assert.equal(r.checklist_hash,hash(run.checklist));
 assert.equal(r.ai_metadata.attempts,1);totals[r.status]++;
 for(const attempt of task.attempts){const a=await store.read(attempt.evaluation_id),u=a.ai_metadata.usage;totals.calls+=a.ai_metadata.attempts;totals.prompt_tokens+=u?.prompt_tokens??0;totals.completion_tokens+=u?.completion_tokens??0;
  if(Number.isFinite(a.ai_metadata.elapsed_ms))latencies.push(a.ai_metadata.elapsed_ms/1000);
  const cached=u?.prompt_tokens_details?.cached_tokens??0,written=u?.prompt_tokens_details?.cache_write_tokens??0;
  if(!u||!Number.isFinite(u.prompt_tokens)||!Number.isFinite(u.completion_tokens)||u.prompt_tokens>272000||u.prompt_tokens<cached+written||!/^gpt-6\.1-sol(?:-|$)/.test(a.ai_metadata.requested_model??a.ai_metadata.model??''))unknownCost++;
  else cost+=((u.prompt_tokens-cached-written)*pricing.input+cached*pricing.cached_input+written*pricing.cache_write_30m+u.completion_tokens*pricing.output)/1e6;
 }
 if(r.ai_review){
  validateReview(r.ai_review,r.checklist,r.conversation);validateDialogFacts(r.ai_facts,r.conversation);assert.deepEqual(r.original_score,calculate(r.checklist,r.ai_review,r.conversation.channel));
  const schema=r.ai_metadata.schema_snapshot,context=r.conversation.transcript.filter(m=>['bot','system'].includes(m.speaker)).map(m=>m.message_id);assert.equal(hash(schema),r.ai_metadata.schema_hash);
  if(r.conversation.transcript.length<=250&&context.length)assert.deepEqual(schema.$defs.evidence_context.properties.message_id.enum,context);
  for(const c of r.ai_review.criteria){const key=c.status==='unresolved'?'unresolved':String(c.value);(distribution[c.criterion_id]??={})[key]=((distribution[c.criterion_id]??{})[key]??0)+1;quotes+=c.evidence.length;ranges+=c.checked_ranges.length;}
 }
 results.push({conversation_id:r.conversation.conversation_id,channel:r.conversation.channel,language:r.conversation.language,evaluation_id:r.evaluation_id,status:r.status,
  total:r.original_score?.total??null,gross_error:r.original_score?.gross_error??null,error:r.error??null,
  unresolved:r.ai_review?.criteria.filter(c=>c.status==='unresolved').map(c=>({id:c.criterion_id,missing_information:c.missing_information}))??[]});
}
latencies.sort((a,b)=>a-b);
const report={notice:'Functional audit of saved provider outputs; no official or independent human GT, no accuracy measured.',run_id:id,configuration:run.execution,total:run.tasks.length,totals,distribution,quotes_verified:quotes,ranges_verified:ranges,
 timing:{wall_seconds:(Date.parse(run.updated_at)-Date.parse(run.created_at))/1000,mean_call_seconds:latencies.reduce((a,b)=>a+b,0)/latencies.length,p95_call_seconds:latencies[Math.ceil(latencies.length*.95)-1],max_call_seconds:latencies.at(-1),notice:'Wall time includes manual pauses/restarts.'},
 estimated_cost:{usd:unknownCost?null:cost,mean_usd_per_dialogue_including_all_attempts:unknownCost?null:cost/run.tasks.length,known_usage_usd:cost,unknown_cost_calls:unknownCost,pricing},results};
await mkdir(join(directory,'audit'),{recursive:true});await writeFile(join(directory,'audit',id+'.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,results:results.filter(r=>r.status!=='completed')}));
