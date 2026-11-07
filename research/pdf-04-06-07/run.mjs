// Bounded live regression experiment, isolated from production reviews.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {hash,normalizeConversation,validateChecklist} from '../../src/domain.js';
import {SYSTEM_PROMPT} from '../../src/ai/prompt.js';
import {createProvider,providerConfig,PROMPT_VERSION,buildMessages} from '../../src/ai/provider.js';
import {EvaluationService} from '../../src/service.js';
import {Store} from '../../src/store.js';

const args=process.argv.slice(2);
assert.ok(args.every(a=>['--live','--stage=before','--stage=after','--stage=confirmed'].includes(a)));
const live=args.includes('--live'),stage=args.includes('--stage=confirmed')?'confirmed':args.includes('--stage=after')?'after':'before';
const suite=JSON.parse(await readFile(new URL('./cases.json',import.meta.url),'utf8'));
const checklist=JSON.parse(await readFile(new URL('../../config/checklist.organizer-2026-11-07.json',import.meta.url),'utf8'));
validateChecklist(checklist);
const make=(language,messages)=>normalizeConversation({conversation_id:`diagnostic-${randomUUID()}`,channel:'agent chat',language,audio_url:null,
 transcript:messages.map(([speaker,text],i)=>({speaker,text,timestamp:`${String(Math.floor(i*15/60)).padStart(2,'0')}:${String(i*15%60).padStart(2,'0')}`}))});
const cases=[];
for(const pair of suite.pairs)for(const v of pair.variants){
 const messages=v.messages??[...pair.prefix,...v.ending];
 cases.push({case_id:`${pair.id}/${v.id}`,kind:'paired',pair_id:pair.id,expected:{[pair.target]:[v.expected]},conversation:make(pair.language,messages)});
}
for(const c of suite.controls)cases.push({case_id:c.id,kind:'control',expected:{[c.target]:[c.expected]},conversation:make(c.language,c.messages)});
assert.equal(cases.length,20);
const oldRun=JSON.parse(await readFile('data/runs/608e0e6b-72f4-4ea6-b34f-3c1bbaa04704.json','utf8'));
assert.equal(hash(oldRun.checklist),hash(checklist));
let activeSuite=suite;
if(stage==='confirmed'){
 activeSuite=JSON.parse(await readFile(new URL('./closing-controls.json',import.meta.url),'utf8'));cases.length=0;
 for(const c of activeSuite.controls)cases.push({case_id:c.id,kind:'closing control',expected:c.expected,conversation:make(c.language,c.messages)});
}
if(stage==='after'||stage==='confirmed'){
 for(const c of activeSuite.dev){
  const task=oldRun.tasks.find(t=>t.conversation_id===c.id);assert.ok(task);
  const old=JSON.parse(await readFile(join('data',task.evaluation_id+'.json'),'utf8'));
  cases.push({case_id:c.id,kind:'DEV diagnostic',expected:c.expected,disputed:c.disputed??{},conversation:old.conversation,baseline_evaluation_id:old.evaluation_id,
   baseline_criteria:old.ai_review.criteria.map(c=>({id:c.criterion_id,value:c.status==='resolved'?c.value:null,status:c.status,explanation:c.explanation}))});
 }
 for(const id of activeSuite.repeat_dev){const c=cases.find(c=>c.case_id===id);cases.push({...c,case_id:id+'/repeat',repeat_of:id});}
}
assert.equal(cases.length,stage==='before'?20:stage==='confirmed'?12:44);
const directory=resolve('data/rubric-regression',live?stage:'prepared-'+stage);
if(live){try{await access(directory);throw Error('Existing experiment preserved; choose a new explicit experiment directory in code before another paid run.');}catch(e){if(e.code!=='ENOENT')throw e;}}
await mkdir(directory,{recursive:true});
const config=providerConfig();if(live){assert.ok(config.ready,'AI configuration unavailable');assert.equal(config.model,'gpt-6.1-sol');}
const runId=randomUUID(),reportStore=new Store(join(directory,'manifest'));await reportStore.init();
const report={run_id:runId,stage,live,started_at:new Date().toISOString(),prompt_version:PROMPT_VERSION,prompt_hash:hash(SYSTEM_PROMPT),suite_hash:hash(activeSuite),
 checklist_hash:hash(checklist),reference_hash:hash(''),notice:suite.notice,concurrency:3,planned_calls:live?cases.length:0,model_calls:0,
 settings:{model:config.model,protocol:config.protocol,response_format:config.responseFormat,reasoning_effort:config.reasoningEffort,max_completion_tokens:config.maxCompletionTokens,timeout_ms:config.timeoutMs},attempts:[]};
const save=()=>reportStore.transaction(()=>reportStore.write(runId,structuredClone(report)));
await writeFile(join(directory,'system-prompt.txt'),SYSTEM_PROMPT);
await writeFile(join(directory,'prepared.json'),JSON.stringify({checklist,cases},null,2));await save();
console.log(JSON.stringify({stage,live,prompt_version:PROMPT_VERSION,cases:cases.length,directory}));
if(live){
 await mkdir(join(directory,'transport'),{recursive:true});let calls=0;
 const provider=createProvider(config,async(url,options)=>{
  const number=++calls;assert.ok(number<=cases.length,'Paid call cap');report.model_calls=calls;
  const request=JSON.parse(options.body);assert.equal(request.messages[0].content,SYSTEM_PROMPT);
  assert.ok(!options.body.includes('"audio_url"'));assert.ok(!config.apiKey||!options.body.includes(config.apiKey));
  await writeFile(join(directory,'transport',`${number}-request.json`),JSON.stringify(request,null,2));
  const response=await fetch(url,options);let payload=null;try{payload=await response.clone().json();}catch{}
  const safeString=s=>typeof s==='string'&&config.apiKey?s.split(config.apiKey).join('[REDACTED]'):s;
  const safe={http_status:response.status,model:payload?.model??null,usage:payload?.usage??null,choices:payload?.choices?.map(c=>({finish_reason:c.finish_reason,message:{content:safeString(c.message?.content??null),refusal:safeString(c.message?.refusal??null)}}))??null};
  await writeFile(join(directory,'transport',`${number}-response.json`),JSON.stringify(safe,null,2));return response;
 });
 const store=new Store(join(directory,'evaluations'));await store.init();
 const service=new EvaluationService(store,provider,'','no-reference-supplied');let next=0;
 const worker=async()=>{while(next<cases.length){const c=cases[next++];
  const record=await service.evaluate(c.conversation,checklist,{runId});
  const criteria=record.ai_review?.criteria??[];
  const values=Object.fromEntries(criteria.map(r=>[r.criterion_id,r.status==='resolved'?r.value:null]));
  const checks=Object.entries(c.expected).map(([id,expected])=>({id,expected,value:values[id]??null,result:record.status==='failed'?'failed':values[id]==null?'unresolved':expected.includes(values[id])?'match':'mismatch'}));
  const item={case_id:c.case_id,kind:c.kind,pair_id:c.pair_id??null,repeat_of:c.repeat_of??null,baseline_evaluation_id:c.baseline_evaluation_id??null,
   baseline_criteria:c.baseline_criteria??null,evaluation_id:record.evaluation_id,status:record.status,values,checks,disputed:c.disputed??{},
   error:record.error??null,elapsed_ms:record.ai_metadata?.elapsed_ms??null,usage:record.ai_metadata?.usage??null};
  report.attempts.push(item);await save();console.log(JSON.stringify({stage,case_id:c.case_id,status:record.status,checks}));
 }};
 const outcomes=await Promise.allSettled([worker(),worker(),worker()]);for(const o of outcomes)if(o.status==='rejected')throw o.reason;
 assert.equal(report.attempts.length,cases.length);assert.equal(report.model_calls,cases.length);
 report.completed_at=new Date().toISOString();await save();
}
await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({stage,model_calls:report.model_calls,accepted:report.attempts.filter(a=>a.status!=='failed').length,checks:report.attempts.flatMap(a=>a.checks).reduce((m,c)=>(m[c.result]=(m[c.result]??0)+1,m),{})}));
