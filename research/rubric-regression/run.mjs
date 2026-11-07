import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {normalizeConversation,validateChecklist,hash} from '../../src/domain.js';
import {buildMessages,createProvider,providerConfig,PROMPT_VERSION} from '../../src/ai/provider.js';
import {buildReviewSchema} from '../../src/ai/schema.js';
import {EvaluationService} from '../../src/service.js';
import {Store} from '../../src/store.js';
const args=process.argv.slice(2);
assert.ok(args.every(a=>['--live','--repeats=1','--repeats=2','--repeats=3'].includes(a)),'Use --live and optionally --repeats=1|2|3. Default: preparation only.');
const live=args.includes('--live'),repeats=Number(args.find(a=>a.startsWith('--repeats='))?.split('=')[1]??3);
const suite=JSON.parse(await readFile(new URL('./cases.json',import.meta.url),'utf8'));
const checklist=JSON.parse(await readFile(new URL('../../config/checklist.organizer-2026-11-07.json',import.meta.url),'utf8'));validateChecklist(checklist);
const seen=new Set();
const cases=suite.cases.map((c,i)=>{
 assert.ok(!seen.has(c.id),'Duplicate case');seen.add(c.id);
 const criterion=checklist.criteria.find(k=>k.id===c.criterion_id);assert.ok(criterion,'Unknown criterion');
 assert.ok(c.expected===null||Array.isArray(c.expected)&&c.expected.length&&c.expected.every(v=>criterion.allowed_values.includes(v)),'Invalid expectation');
 const conversation=normalizeConversation({conversation_id:`calib-${String(i+1).padStart(3,'0')}`,channel:'agent chat',language:c.language,audio_url:null,
  transcript:c.messages.map(([speaker,text],j)=>({speaker,text,timestamp:`00:${String(j*5).padStart(2,'0')}`}))});
 const messages=buildMessages(conversation,checklist,'','json_schema');
 const payload=JSON.parse(messages[1].content);
 assert.deepEqual(Object.keys(payload),['checklist','conversation','verified_reference']);
 assert.ok(!messages.some(m=>m.content.includes(c.id)),'Descriptive benchmark ID leaked');
 return {...c,conversation,messages,schema:buildReviewSchema(checklist,'agent chat',conversation)};
});
const directory=resolve('data/rubric-regression',live?new Date().toISOString().replaceAll(':','-'):'prepared');await mkdir(directory,{recursive:true});
const config=providerConfig();
if(live)assert.ok(config.ready,'Configure the provider before --live.');
// Only the production provider builds model input. expected/basis/case IDs never enter evaluate().
await writeFile(join(directory,'requests.json'),JSON.stringify(cases.map(c=>({case_id:c.id,messages:c.messages,schema:c.schema,expected:c.expected,basis:c.basis})),null,2));
const report={suite_version:suite.version,notice:suite.notice,prompt_version:PROMPT_VERSION,checklist_hash:hash(checklist),live,repeats:live?repeats:0,
 planned_calls:live?cases.length*repeats:0,model_calls:0,accuracy_measured:false,official_GT:false,expert_pending:cases.filter(c=>c.expected===null).map(c=>c.id),attempts:[],summary:[]};
const save=()=>writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));await save();
if(live){
 const store=new Store(directory);await store.init();const service=new EvaluationService(store,createProvider(config),'','no-reference-supplied');
 for(const c of cases){
  const outcomes=[];
  for(let repeat=1;repeat<=repeats;repeat++){
   const r=await service.evaluate(c.conversation,checklist),row=r.ai_review?.criteria.find(x=>x.criterion_id===c.criterion_id);
   report.model_calls+=r.ai_metadata?.attempts??0;
   const outcome=r.status==='failed'?'failed':row?.status==='unresolved'?'unresolved':JSON.stringify(row?.value);
   const status=r.status==='failed'?'failed':row?.status==='unresolved'?'unresolved':c.expected===null?'expert_pending':c.expected.includes(row.value)?'match':'mismatch';
   outcomes.push(outcome);report.attempts.push({case_id:c.id,repeat,evaluation_id:r.evaluation_id,target_status:status,value:row?.value??null,
    explanation:row?.explanation??null,missing_information:row?.missing_information??[],error:r.error??null,overall_status:r.status,usage:r.ai_metadata?.usage??null,elapsed_ms:r.ai_metadata?.elapsed_ms??null});
   await save();console.log(JSON.stringify({case_id:c.id,repeat,status,value:row?.value??null}));
  }
  report.summary.push({case_id:c.id,expected:c.expected,outcomes,identical_in_observed_runs:new Set(outcomes).size===1});await save();
 }
}
if(live){
 const labelledIds=new Set(cases.filter(c=>c.expected!==null).map(c=>c.id));
 const labelled=report.attempts.filter(a=>labelledIds.has(a.case_id));
 report.labelled_summary={attempts:labelled.length,matches:labelled.filter(a=>a.target_status==='match').length,
  mismatches:labelled.filter(a=>a.target_status==='mismatch').length,unresolved:labelled.filter(a=>a.target_status==='unresolved').length,failed:labelled.filter(a=>a.target_status==='failed').length};
 if(labelled.some(a=>a.target_status!=='match')||report.attempts.some(a=>a.target_status==='failed'))process.exitCode=1;
}
report.warning='Repeated agreement on these known examples is not proof of 100% stability or production accuracy. No automatic deployment or change to human-approved rules.';
await save();console.log(JSON.stringify({directory,cases:cases.length,prepared:true,model_calls:report.model_calls,expert_pending:report.expert_pending}));
