// Offline audit: regenerate a candidate in tmp, never replace published results.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {main as exportCLI} from '../../scripts/export-results.mjs';
import {hash,importConversations,validateReview} from '../../src/domain.js';
import {validateDialogFacts} from '../../src/ai/facts.js';
import {calculate} from '../../src/scoring.js';
import {SUBMISSION_CRITERIA,validateSubmission} from '../../src/submission.js';
import {SYSTEM_PROMPT} from '../../src/ai/prompt.js';
import {PROMPT_VERSION} from '../../src/ai/provider.js';

const runId='d6db1bd3-d1d3-4523-b24b-e4e3ee2fd498';
const source=resolve('data/prod-terra-2026-11-08');
const sandbox=resolve('tmp/submission-original-audit-2026-11-08');
const json=async f=>JSON.parse(await readFile(f,'utf8'));
const sha=async f=>createHash('sha256').update(await readFile(f)).digest('hex');
const protectedFiles=['results/dev/results.json','results/prod/results.json','data/submissions/prod.manifest.json','src/ai/prompt.js','src/ai/provider.js'];
protectedFiles.push('data/prod-terra-reviewed-2026-11-08/dd6a83c8-18b5-4e99-87a8-b8e2f37cd937.json','data/prod-final-complete-2026-11-08/0c8f0094-5f84-408b-a001-ce545d2661db.json');
const recordFiles=manifest=>manifest.selected_evaluations.map(x=>source+'/'+x.evaluation_id+'.json');
protectedFiles.push(...recordFiles(await json('data/submissions/prod.manifest.json')));
const before=Object.fromEntries(await Promise.all(protectedFiles.map(async f=>[f,await sha(f)])));
const manifest=await json('data/submissions/prod.manifest.json');
assert.equal(manifest.source_view,'original');assert.equal(manifest.run_id,runId);
const run=await json(source+'/runs/'+runId+'.json');
assert.equal(run.status,'completed');assert.equal(run.subset,'prod');assert.equal(run.tasks.length,10);
assert.equal(PROMPT_VERSION,'cqa-facts-1.6.1-contextual-recap');
assert.equal(run.execution.prompt_version,PROMPT_VERSION);assert.equal(run.execution.prompt_hash,hash(SYSTEM_PROMPT));
assert.equal(run.execution.requested_model,'gpt-6.1-terra');assert.equal(run.execution.reference_hash,hash(''));
const input=await json('data/prod/source.json'),conversations=importConversations(input);
assert.deepEqual(run.tasks.map(t=>t.conversation_id),conversations.map(c=>c.conversation_id));
assert.equal(run.dataset_hash,hash(conversations));
const records=[];
for(const selected of manifest.selected_evaluations){
 const task=run.tasks.find(t=>t.conversation_id===selected.conversation_id);assert(task);
 assert.equal(task.evaluation_id,selected.evaluation_id);assert.equal(task.attempts.at(-1).evaluation_id,selected.evaluation_id);
 const r=await json(source+'/'+selected.evaluation_id+'.json');records.push(r);
 assert.equal(r.run_id,runId);assert.equal(r.conversation.conversation_id,task.conversation_id);
 assert.deepEqual(r.execution_snapshot,run.execution);assert.equal(r.configuration_hash,run.configuration_hash);
 assert.deepEqual(r.conversation,task.conversation);assert.equal(r.conversation_hash,hash(r.conversation));
 assert.deepEqual(r.checklist,run.checklist);assert.equal(r.checklist_hash,hash(run.checklist));
 assert.equal(r.ai_metadata.model,'gpt-6.1-terra');assert.equal(r.reference_snapshot.text,'');
 assert.equal(r.reference_hash,hash(''));assert.equal(r.appeals.length,0);
 validateReview(r.ai_review,r.checklist,r.conversation);validateDialogFacts(r.ai_facts,r.conversation);
 assert.deepEqual(calculate(r.checklist,r.ai_review,r.conversation.channel),r.original_score);
}
await mkdir(sandbox,{recursive:true});
const output=resolve(sandbox,'prod/results.json');
let exportReport;
assert.equal(await exportCLI(['export','--subset','prod','--dataset',resolve('data/prod/source.json'),'--evaluations-dir',source,'--run-id',runId,'--view','original','--output',output],{cwd:sandbox,out:s=>{exportReport=JSON.parse(s);},err:s=>{throw Error(s);}}),0);
const prepared=await json(output),candidateManifest=await json(resolve(sandbox,'data/submissions/prod.manifest.json'));
for(const [k,v] of Object.entries(manifest))if(!['generated_at','output'].includes(k))assert.deepEqual(candidateManifest[k],v,'manifest '+k);
assert.equal(await sha(output),before['results/prod/results.json']);
assert.equal(execFileSync('git',['show','HEAD:results/prod/results.json'],{encoding:'utf8'}),await readFile(output,'utf8'));
let quotes=0,ranges=0,turnSets=0,fullMath=0,partialMath=0;
const arithmetic=[];
for(const r of records){
 const exported=prepared.results.find(x=>x.conversation_id===r.conversation.conversation_id);
 const rows=new Map(r.ai_review.criteria.map(c=>[c.criterion_id,c]));
 let numerator=0n,denominator=0n,blocked=false;
 for(const c of r.checklist.criteria){
  const row=rows.get(c.id);quotes+=row.evidence.length;ranges+=row.checked_ranges.length;
  if(c.id==='06')assert([0,4,7,10].includes(row.value));
  if(c.type==='flag'){assert.equal(c.weight,0);continue;}
  if(row.status==='unresolved'){if(c.weight>0)blocked=true;continue;}
  if(row.value==='na')continue;
  assert(Number.isInteger(c.weight));const weight=BigInt(c.weight);
  const max=c.type==='scale'?BigInt(Math.max(...c.scale.map(x=>x.value))):1n;
  const value=c.type==='scale'?BigInt(row.value):row.value==='yes'?1n:0n;
  assert.equal(20n%max,0n);numerator+=weight*value*(20n/max);denominator+=weight*20n;
 }
 const total=blocked||denominator===0n?null:Number((numerator*10000n*2n+denominator)/(denominator*2n))/100;
 assert.equal(total,r.original_score.total);arithmetic.push({conversation_id:r.conversation.conversation_id,total});
 if(exported.status==='error'){partialMath++;assert.equal(exported.score,null);assert.deepEqual(exported.criteria,[]);assert(exported.error.includes('consultation'));continue;}
 fullMath++;assert.equal(exported.score.final_score,total);
 assert.equal(exported.score.critical_flag,r.ai_review.criteria.find(c=>c.criterion_id==='08').value==='yes');
 const positions=new Map(r.conversation.transcript.map((m,i)=>[m.message_id,i+1]));
 for(const c of exported.criteria){
  const spec=SUBMISSION_CRITERIA.find(s=>s.code===c.criterion_id),row=rows.get(spec.id);
  const expected=new Set(row.evidence.map(e=>positions.get(e.message_id)));
  for(const range of row.checked_ranges)for(let i=positions.get(range.from_message_id);i<=positions.get(range.to_message_id);i++)expected.add(i);
  assert.deepEqual(c.evidence_turns,[...expected].sort((a,b)=>a-b));turnSets++;
  assert.equal(c.value,row.value==='na'?null:row.value==='yes'?true:row.value==='no'?false:row.value);
 }
}
const devValidation=validateSubmission(await json('results/dev/results.json'),{dataset:await json('data/dev/api-response.json'),subset:'dev',checklist:run.checklist});
const prodValidation=validateSubmission(prepared,{dataset:input,subset:'prod',checklist:run.checklist});
for(const f of protectedFiles)assert.equal(await sha(f),before[f],'changed protected file '+f);
const report={run_id:runId,model:'gpt-6.1-terra',source_view:'original',external_reference_loaded:false,selected_ids:records.map(r=>r.conversation.conversation_id),dev:devValidation,prod:prodValidation,run_and_export_manifests_match:true,published_prod_equals_regenerated_original:true,published_files_and_active_prompt_unchanged:true,original_records_and_review_history_unchanged:true,source_quotes_checked:quotes,checked_ranges:ranges,evidence_turn_sets_checked:turnSets,independent_integer_arithmetic:{full:fullMath,partial:partialMath,results:arithmetic},prepared_file:output,published_sha256:before['results/prod/results.json'],calls_added:0};
await writeFile(resolve(sandbox,'audit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
