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
const args=process.argv.slice(2);assert.ok(args.every(a=>['--live','--stage=baseline','--stage=candidate','--actual-only'].includes(a)),'Use --stage=baseline|candidate [--live] [--actual-only]');
const live=args.includes('--live'),stage=args.includes('--stage=candidate')?'candidate':'baseline',actualOnly=args.includes('--actual-only');
const suite=JSON.parse(await readFile(new URL('./cases.json',import.meta.url),'utf8'));
const checklist=JSON.parse(await readFile(new URL('../../config/checklist.organizer-2026-11-07.json',import.meta.url),'utf8'));validateChecklist(checklist);
const normalized=(id,language,messages)=>normalizeConversation({conversation_id:id,channel:'agent chat',language,audio_url:null,
 transcript:messages.map(([speaker,text],i)=>({speaker,text,timestamp:`${String(Math.floor(i*20/60)).padStart(2,'0')}:${String(i*20%60).padStart(2,'0')}`}))});
const cases=[];
for(const p of suite.pairs){
 const first=cases.length;
 for(const v of p.variants){const id=`c06-${String(cases.length+1).padStart(3,'0')}`;
  cases.push({case_id:`${p.id}/${v.id}`,pair:p.id,kind:'paired',expected:v.expected,repeats:2,
   conversation:normalized(id,p.language,[...p.prefix,['operator',v.operator],['client',v.client],...p.suffix])});}
 const a=cases[first].conversation.transcript,b=cases[first+1].conversation.transcript;
 assert.equal(a.length,b.length);assert.deepEqual(a.flatMap((m,i)=>hash(m)!==hash(b[i])?[i]:[]),[3,4]);
}
if(actualOnly)cases.length=0;
if(stage==='candidate'&&!actualOnly){
 for(const c of suite.controls)cases.push({case_id:c.id,pair:null,kind:'control',expected:c.expected,expected02:c.expected02,repeats:1,
  conversation:normalized(`c06-${String(cases.length+1).padStart(3,'0')}`,c.language,c.messages)});
}
if(stage==='candidate'||actualOnly){
 const actual=JSON.parse(await readFile(new URL('../../data/fd250f6a-55d8-4483-a88a-8c09083790ef.json',import.meta.url),'utf8'));
 assert.equal(hash(actual.checklist),hash(checklist));
 cases.push({case_id:'actual-kz-008',kind:'DEV diagnostic',pair:null,expected:7,expected02:'na',repeats:2,conversation:actual.conversation});
}
const prepared=cases.map(c=>({...c,messages:buildMessages(c.conversation,checklist,'','json_schema'),schema:buildReviewSchema(checklist,c.conversation.channel,c.conversation)}));
for(const c of prepared){assert.deepEqual(Object.keys(JSON.parse(c.messages[1].content)),['checklist','conversation','verified_reference']);assert.ok(!JSON.stringify(c.messages).includes(c.case_id));}
const runName=stage+(actualOnly?'-actual':'');
const directory=resolve('data/criterion06-pairs',live?runName:'prepared-'+runName);await mkdir(directory,{recursive:true});
if(live){try{await readFile(join(directory,'report.json'));throw Error('Existing experiment preserved.');}catch(e){if(e.code!=='ENOENT')throw e;}}
const config=providerConfig();if(live){assert.ok(config.ready);assert.equal(config.model,'gpt-6.1-sol');assert.ok(stage!=='baseline'||PROMPT_VERSION==='cqa-facts-1.2-applicability-first');}
await writeFile(join(directory,'prepared.json'),JSON.stringify(prepared,null,2));await writeFile(join(directory,'system-prompt.txt'),SYSTEM_PROMPT);
const report={stage,started_at:new Date().toISOString(),suite_hash:hash(suite),checklist_hash:hash(checklist),prompt_version:PROMPT_VERSION,prompt_hash:hash(SYSTEM_PROMPT),
 notice:suite.notice,source:suite.authority,live,concurrency:2,planned_calls:live?cases.reduce((n,c)=>n+c.repeats,0):0,model_calls:0,
 settings:{model:config.model,protocol:config.protocol,response_format:config.responseFormat,reasoning_effort:config.reasoningEffort,max_completion_tokens:config.maxCompletionTokens,timeout_ms:config.timeoutMs},attempts:[]};
let queue=Promise.resolve();const save=()=>{const snapshot=JSON.stringify(report,null,2);queue=queue.then(async()=>{const temp=join(directory,`report-${randomUUID()}.tmp`);await writeFile(temp,snapshot);await rename(temp,join(directory,'report.json'));});return queue;};
await save();
if(live){
 await mkdir(join(directory,'transport'),{recursive:true});let networkCalls=0;
 const provider=createProvider(config,async(url,options)=>{
  assert.ok(++networkCalls<=report.planned_calls,'Network call cap');report.model_calls=networkCalls;
  const number=networkCalls,request=JSON.parse(options.body);assert.ok(!config.apiKey||!options.body.includes(config.apiKey));assert.ok(!options.body.includes('"audio_url"'));
  await writeFile(join(directory,'transport',`${number}-request.json`),JSON.stringify(request,null,2));
  const response=await fetch(url,options);let raw;try{raw=await response.clone().json();}catch{raw=null;}
  const redact=s=>typeof s==='string'&&config.apiKey?s.split(config.apiKey).join('[REDACTED]'):s;
  const safe={http_status:response.status,model:raw?.model??null,usage:raw?.usage??null,choices:raw?.choices?.map(c=>({finish_reason:c.finish_reason,message:{content:redact(c.message?.content??null),refusal:redact(c.message?.refusal??null)}}))??null};
  await writeFile(join(directory,'transport',`${number}-response.json`),JSON.stringify(safe,null,2));return response;
 });
 const store=new Store(directory);await store.init();const service=new EvaluationService(store,provider,'','no-reference-supplied');
 const jobs=cases.flatMap(c=>Array.from({length:c.repeats},(_,i)=>({c,repeat:i+1})));let next=0;
 const worker=async()=>{while(next<jobs.length){const {c,repeat}=jobs[next++];const r=await service.evaluate(c.conversation,checklist);
  const row=r.ai_review?.criteria.find(c=>c.criterion_id==='06'),c02=r.ai_review?.criteria.find(c=>c.criterion_id==='02');
  const item={case_id:c.case_id,pair:c.pair,kind:c.kind,repeat,expected:c.expected,evaluation_id:r.evaluation_id,overall_status:r.status,value06:row?.value??null,
   target_status:r.status==='failed'?'failed':row?.status==='unresolved'?'unresolved':row?.value===c.expected?'match':'mismatch',
   explanation06:row?.explanation??null,evidence06:row?.evidence??[],ranges06:row?.checked_ranges??[],value02:c02?.value??null,
   expected02:c.expected02??null,usage:r.ai_metadata?.usage??null,elapsed_ms:r.ai_metadata?.elapsed_ms??null,error:r.error??null};
  report.attempts.push(item);await save();console.log(JSON.stringify({stage,case_id:c.case_id,repeat,value06:item.value06,status:item.target_status}));
 }};
 const outcomes=await Promise.allSettled([worker(),worker()]);for(const o of outcomes)if(o.status==='rejected')throw o.reason;
 assert.equal(report.model_calls,report.planned_calls);
 report.summary=cases.map(c=>({case_id:c.case_id,kind:c.kind,expected:c.expected,outcomes:report.attempts.filter(a=>a.case_id===c.case_id).sort((a,b)=>a.repeat-b.repeat).map(a=>a.value06)}));
 report.completed_at=new Date().toISOString();
}
await save();console.log(JSON.stringify({stage,directory,model_calls:report.model_calls,prepared_cases:cases.length}));
