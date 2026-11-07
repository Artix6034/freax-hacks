import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {hash,normalizeConversation,validateChecklist} from '../../src/domain.js';
import {buildMessages,createProvider,providerConfig,PROMPT_VERSION} from '../../src/ai/provider.js';
import {SYSTEM_PROMPT} from '../../src/ai/prompt.js';
import {buildReviewSchema} from '../../src/ai/schema.js';
import {EvaluationService} from '../../src/service.js';
import {Store} from '../../src/store.js';

const args=process.argv.slice(2);
assert.ok(args.every(a=>['--live','--stage=baseline','--stage=candidate','--stage=holdout'].includes(a)));
const live=args.includes('--live'),stage=args.find(a=>a.startsWith('--stage='))?.slice(8)||'baseline';
const suite=JSON.parse(await readFile(new URL('./cases.json',import.meta.url),'utf8'));
const checklist=JSON.parse(await readFile(new URL('../../config/checklist.organizer-2026-11-07.json',import.meta.url),'utf8'));validateChecklist(checklist);
const cases=[];let counter=0;
const normalize=(id,language,messages)=>normalizeConversation({conversation_id:id,channel:'agent chat',language,audio_url:null,
 transcript:messages.map(([speaker,text],i)=>({speaker,text,timestamp:`${String(Math.floor(i*25/60)).padStart(2,'0')}:${String(i*25%60).padStart(2,'0')}`}))});
for(const p of suite.pairs){
 for(const v of p.variants){
  const id=`qa-${String(++counter).padStart(3,'0')}`;if((stage==='holdout')!==(p.split==='holdout'))continue;
  cases.push({case_id:`${p.id}/${v.id}`,pair:p.id,kind:'paired',criterion_id:p.criterion_id,expected:v.expected??null,expected_status:null,
   basis:p.basis,repeats:stage==='holdout'?1:2,conversation:normalize(id,p.language,[...p.prefix,...v.middle,...p.suffix])});
 }
}
if(stage!=='holdout'){
 for(const c of suite.controls)cases.push({...c,case_id:c.id,kind:'control',expected:c.expected??null,expected_status:c.expected_status??null,repeats:1,
  conversation:normalize(`qa-${String(++counter).padStart(3,'0')}`,c.language,c.messages)});
 const actualFiles=['../../data/live-smoke/2026-11-07-c04-recheck-01/773d7c65-e8a2-4f2e-90f5-616de6548b23.json','../../data/fd250f6a-55d8-4483-a88a-8c09083790ef.json'];
 for(const file of actualFiles){const r=JSON.parse(await readFile(new URL(file,import.meta.url),'utf8'));assert.equal(hash(r.checklist),hash(checklist));
  cases.push({case_id:`actual-${r.conversation.conversation_id}`,kind:'DEV diagnostic',criterion_id:'04+05',expected:null,expected_status:null,repeats:1,
   basis:'No independent human verdict yet. Preserve all outcomes without declaring accuracy.',conversation:r.conversation});}
}
if(stage==='holdout'){
 const ids=['p1-ru-026','p1-kz-003'];
 const split=JSON.parse(await readFile(new URL('../dev-split-v1.json',import.meta.url),'utf8'));
 const lines=(await readFile(new URL('../../data/dev/indexed-transcripts.jsonl',import.meta.url),'utf8')).trim().split(/\r?\n/);
 for(const id of ids){
  assert.ok(split.pilot20.includes(id)&&!split.holdout10.includes(id));
  const r=lines.map(line=>JSON.parse(line)).find(r=>r.conversation_id===id);assert.ok(r);
  cases.push({case_id:`fresh-${id}`,kind:'fresh pilot diagnostic',criterion_id:'04+05',expected:null,expected_status:null,repeats:1,
   basis:'Previously unevaluated by the working provider in this audit. Selected from pilot20, never the reserved human holdout10. No expert score.',
   conversation:normalizeConversation({conversation_id:id,channel:r.channel,language:r.language,audio_url:null,transcript:r.messages})});
 }
}
const directory=resolve('data/criteria04-05',live?stage:'prepared-'+stage);await mkdir(directory,{recursive:true});
if(live){try{await readFile(join(directory,'report.json'));throw Error('Existing run preserved.');}catch(e){if(e.code!=='ENOENT')throw e;}}
const prepared=cases.map(c=>({...c,messages:buildMessages(c.conversation,checklist,'','json_schema'),schema:buildReviewSchema(checklist,c.conversation.channel,c.conversation)}));
for(const c of prepared){assert.deepEqual(Object.keys(JSON.parse(c.messages[1].content)),['checklist','conversation','verified_reference']);assert.ok(!JSON.stringify(c.messages).includes(c.case_id));}
if(live&&stage!=='baseline'){
 const baseline=JSON.parse(await readFile(resolve('data/criteria04-05/baseline/report.json'),'utf8'));assert.ok(baseline.completed_at);
 assert.equal(baseline.suite_hash,hash(suite));
 if(stage==='candidate'){
  assert.notEqual(baseline.prompt_hash,hash(SYSTEM_PROMPT),'Do not repeat an unchanged prompt as a candidate.');
  const old=JSON.parse(await readFile(resolve('data/criteria04-05/baseline/prepared.json'),'utf8'));
  for(const c of prepared){const before=old.find(x=>x.case_id===c.case_id);assert.deepEqual(before.messages[1],c.messages[1]);assert.deepEqual(before.schema,c.schema);}
 }
}
const config=providerConfig();if(live){assert.ok(config.ready);assert.ok(stage!=='baseline'||PROMPT_VERSION==='cqa-facts-1.3-dialogue-scale-grounding');}
await writeFile(join(directory,'prepared.json'),JSON.stringify(prepared,null,2));await writeFile(join(directory,'system-prompt.txt'),SYSTEM_PROMPT);
const report={stage,started_at:new Date().toISOString(),suite_hash:hash(suite),checklist_hash:hash(checklist),prompt_version:PROMPT_VERSION,prompt_hash:hash(SYSTEM_PROMPT),notice:suite.notice,
 settings:{model:config.model,protocol:config.protocol,response_format:config.responseFormat,reasoning_effort:config.reasoningEffort,max_completion_tokens:config.maxCompletionTokens,timeout_ms:config.timeoutMs},
 live,concurrency:2,planned_calls:live?cases.reduce((n,c)=>n+c.repeats,0):0,model_calls:0,attempts:[]};
let queue=Promise.resolve();const save=()=>{const snapshot=JSON.stringify(report,null,2);queue=queue.then(async()=>{const temp=join(directory,`report-${randomUUID()}.tmp`);await writeFile(temp,snapshot);await rename(temp,join(directory,'report.json'));});return queue;};await save();
if(live){
 await mkdir(join(directory,'transport'),{recursive:true});let networkCalls=0;
 const provider=createProvider(config,async(url,options)=>{
  const n=++networkCalls;assert.ok(n<=report.planned_calls);report.model_calls=n;
  assert.ok(!config.apiKey||!options.body.includes(config.apiKey));assert.ok(!options.body.includes('"audio_url"'));
  await writeFile(join(directory,'transport',`${n}-request.json`),JSON.stringify(JSON.parse(options.body),null,2));
  const response=await fetch(url,options);let raw;try{raw=await response.clone().json();}catch{raw=null;}
  const safeText=s=>typeof s==='string'&&config.apiKey?s.split(config.apiKey).join('[REDACTED]'):s;
  const safe={http_status:response.status,model:raw?.model??null,usage:raw?.usage??null,choices:raw?.choices?.map(c=>({finish_reason:c.finish_reason,message:{content:safeText(c.message?.content??null),refusal:safeText(c.message?.refusal??null)}}))??null};
  await writeFile(join(directory,'transport',`${n}-response.json`),JSON.stringify(safe,null,2));return response;
 });
 const store=new Store(directory);await store.init();const service=new EvaluationService(store,provider,'','no-reference-supplied');
 const jobs=cases.flatMap(c=>Array.from({length:c.repeats},(_,i)=>({c,repeat:i+1})));let next=0;
 const worker=async()=>{while(next<jobs.length){const {c,repeat}=jobs[next++],r=await service.evaluate(c.conversation,checklist);
  const target=r.ai_review?.criteria.find(x=>x.criterion_id===c.criterion_id);
  const target_status=r.status==='failed'?'failed':c.expected_status?(target?.status===c.expected_status?'match':'mismatch'):
   c.expected===null?'diagnostic':target?.status==='unresolved'?'unresolved':target?.value===c.expected?'match':'mismatch';
  const item={case_id:c.case_id,kind:c.kind,criterion_id:c.criterion_id,repeat,expected:c.expected,expected_status:c.expected_status,
   evaluation_id:r.evaluation_id,overall_status:r.status,target_status,criteria:r.ai_review?.criteria.map(x=>({criterion_id:x.criterion_id,status:x.status,value:x.value,explanation:x.explanation,evidence:x.evidence,checked_ranges:x.checked_ranges,missing_information:x.missing_information}))??[],
   usage:r.ai_metadata?.usage??null,elapsed_ms:r.ai_metadata?.elapsed_ms??null,error:r.error??null};
  report.attempts.push(item);await save();console.log(JSON.stringify({stage,case_id:c.case_id,repeat,status:target_status,values:item.criteria.filter(x=>['04','05'].includes(x.criterion_id)).map(x=>({id:x.criterion_id,value:x.value,status:x.status}))}));
 }};
 const results=await Promise.allSettled([worker(),worker()]);for(const r of results)if(r.status==='rejected')throw r.reason;
 assert.equal(report.model_calls,report.planned_calls);report.completed_at=new Date().toISOString();
}
await save();console.log(JSON.stringify({stage,directory,cases:cases.length,model_calls:report.model_calls}));
