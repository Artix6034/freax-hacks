// Isolated, bounded experiment through the existing server-side provider.
// No server, official results, labels, source prompt or schema are changed.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {hash,validateChecklist,validateReview} from '../../src/domain.js';
import {validateDialogFacts} from '../../src/ai/facts.js';
import {calculate} from '../../src/scoring.js';
import {SYSTEM_PROMPT} from '../../src/ai/prompt.js';
import {createProvider,providerConfig,PROMPT_VERSION} from '../../src/ai/provider.js';
import {cleanUsage} from '../../src/ai/transport.js';
const args=process.argv.slice(2),opts=Object.fromEntries(args.filter(a=>a.includes('=')).map(a=>a.slice(2).split('=')));
assert.ok(args.every(a=>a==='--live'||/^--(stage|split|candidate)=/.test(a)),'Unknown argument');
const live=args.includes('--live'),stage=opts.stage??'baseline',split=opts.split??'discovery';
assert.match(stage,/^[a-z0-9-]+$/);assert.ok(['discovery','holdout','controls','dev','invariance'].includes(split));
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const suite=await json(new URL('./cases.frozen.json',import.meta.url)),freeze=await json(new URL('./freeze.json',import.meta.url));
assert.equal(hash(suite),freeze.suite_hash,'Frozen expectations changed');
const baseChecklist=validateChecklist(await json('config/checklist.organizer-2026-11-07.json'));
const candidate=opts.candidate?await json(resolve(opts.candidate)):null;
let prompt=SYSTEM_PROMPT,version=PROMPT_VERSION;
if(candidate){
 assert.equal(candidate.base_prompt_hash,freeze.prompt_hash);assert.equal(hash(SYSTEM_PROMPT),freeze.prompt_hash);
 for(const edit of candidate.edits){assert.equal(prompt.split(edit.old).length,2,'Edit must have exactly one anchor');prompt=prompt.replace(edit.old,edit.new);}
 version=candidate.version;
}else assert.equal(hash(prompt),freeze.prompt_hash,'Current prompt changed before baseline');
let selected=suite.cases.filter(c=>c.split===split || split==='discovery'&&c.split==='controls');
let supplementalHash=null;
if(split==='invariance'){const supplement=await json(new URL('./invariance.frozen.json',import.meta.url));selected=supplement.cases;supplementalHash=hash(supplement);}
if(split==='dev'){
 const input=await json('data/reliability/ten-disagreements/input.json');
 selected=input.cases.map(c=>({id:c.id,split:'dev',hypothesis:'DEV diagnostic only',conversation:{schema_version:'1.0',conversation_id:c.id,channel:c.source_label.channel,language:c.source_label.language,audio_url:null,transcript:c.transcript},
  expected:Object.fromEntries(c.criteria.map(r=>[r.key.split(':')[1],{values:[r.expected],reason:r.reference_explanation,disputed:false}]))}));
}
assert.ok(selected.length>0&&selected.length<=47,'Hard bounded call limit');
const config=providerConfig();assert.ok(!live||config.ready,`Local provider not configured: ${config.missing.join(', ')}`);
const root=resolve('data/hypotheses-2026-11-08'),directory=join(root,`${stage}-${split}`);
await mkdir(root,{recursive:true});await mkdir(directory); // EEXIST prevents silent reruns/rebilling.
const runId=randomUUID(),started=new Date().toISOString(),records=[];let calls=0,next=0,fatal=null;
const settings={model:config.model,protocol:config.protocol,response_format:config.responseFormat,reasoning_effort:config.reasoningEffort,max_completion_tokens:config.maxCompletionTokens,timeout_ms:config.timeoutMs};
await writeFile(join(directory,'system-prompt.txt'),prompt);
await writeFile(join(directory,'input.snapshot.json'),JSON.stringify({suite_hash:freeze.suite_hash,checklist:baseChecklist,cases:selected},null,2));
await writeFile(join(directory,'plan.json'),JSON.stringify({runId,stage,split,live,started,prompt_version:version,prompt_hash:hash(prompt),settings,planned_calls:live?selected.length:0,candidate,suite_hash:freeze.suite_hash,supplemental_hash:supplementalHash},null,2));
const safe=s=>String(s).split(config.apiKey||'\u0000').join('[REDACTED]');
async function worker(){while(next<selected.length&&!fatal){
 const c=selected[next++],checklist=structuredClone(baseChecklist);
 if(c.checklist_edit){Object.assign(checklist.criteria.find(r=>r.id===c.checklist_edit.id),c.checklist_edit);checklist.version+=100;}
 validateChecklist(checklist);
 const callNo=++calls,stem=String(callNo).padStart(3,'0');assert.ok(calls<=selected.length);
 const provider=createProvider(config,async(url,options)=>{
  const body=JSON.parse(options.body);assert.equal(body.messages[0].content,SYSTEM_PROMPT);body.messages[0].content=prompt;
  const data=JSON.parse(body.messages[1].content);assert.deepEqual(Object.keys(data).sort(),['checklist','conversation','verified_reference'].sort());
  assert.equal(data.verified_reference,null);assert.ok(!Object.hasOwn(data.conversation,'audio_url'));
  assert.ok(!config.apiKey||!JSON.stringify(body).includes(config.apiKey));
  await writeFile(join(directory,`${stem}.request.json`),JSON.stringify(body,null,2));
  const response=await fetch(url,{...options,body:JSON.stringify(body)});
  if([401,403,429].includes(response.status))fatal=`HTTP ${response.status}: stopped remaining calls`;
  let raw=null;if(response.ok){try{raw=await response.clone().json();}catch{}}
  const retained={http_status:response.status,model:raw?.model??null,usage:cleanUsage(raw?.usage),choices:raw?.choices?.map(x=>({finish_reason:x.finish_reason,message:{content:x.message?.content==null?null:safe(x.message.content),refused:Boolean(x.message?.refusal)}}))??null};
  await writeFile(join(directory,`${stem}.response.json`),JSON.stringify(retained,null,2));return response;
 });
 const record={case_id:c.id,run_id:runId,prompt_version:version,prompt_hash:hash(prompt),conversation:c.conversation,conversation_hash:hash(c.conversation),checklist,checklist_hash:hash(checklist),reference_text:null,status:'started',checks:[]};
 await writeFile(join(directory,`${stem}.started.json`),JSON.stringify({case_id:c.id,started_at:new Date().toISOString()},null,2));
 try{
  const result=await provider.evaluate(c.conversation,checklist,'');
  record.metadata=result.metadata;record.metadata.prompt_version=version;record.metadata.prompt_hash=hash(prompt);
  for(const call of record.metadata.calls)call.prompt_version=version;
  validateDialogFacts(result.dialogFacts,c.conversation);validateReview(result.review,checklist,c.conversation);
  record.review=result.review;record.dialog_facts=result.dialogFacts;record.score=calculate(checklist,result.review,c.conversation.channel);
  record.status=record.score.status;
 }catch(e){record.status='failed';record.error=safe(e.message);record.error_code=e.ai_code??'VALIDATION';record.metadata=e.ai_metadata??record.metadata??null;}
 const byId=new Map(record.review?.criteria.map(r=>[r.criterion_id,r])??[]);
 record.checks=Object.entries(c.expected).map(([id,e])=>{const actual=byId.get(id);const value=actual?.status==='resolved'?actual.value:null;
  return {id,...e,actual_status:actual?.status??null,value,result:record.status==='failed'?'failed':e.values.includes(value)?e.disputed?'within_disputed_set':'match':value===null?'unexpected_unresolved':'mismatch',explanation:actual?.explanation??record.error};});
 await writeFile(join(directory,`${stem}.record.json`),JSON.stringify(record,null,2));records.push(record);
 console.log(JSON.stringify({stage,split,call:callNo,id:c.id,status:record.status,checks:record.checks.map(({id,value,result})=>({id,value,result}))}));
}}
if(live){const outcomes=await Promise.allSettled([worker(),worker(),worker()]);for(const r of outcomes)if(r.status==='rejected')throw r.reason;}
const pricing=await json('research/reliability/pricing.json');let known=0,unpriced=0,inputTokens=0,outputTokens=0;
for(const r of records){const u=r.metadata?.usage,cached=u?.prompt_tokens_details?.cached_tokens??0,written=u?.prompt_tokens_details?.cache_write_tokens??0;
 if(!u||!Number.isFinite(u.prompt_tokens)||!Number.isFinite(u.completion_tokens)||u.prompt_tokens<cached+written||!r.metadata?.model?.startsWith(pricing.model)){unpriced++;continue;}
 inputTokens+=u.prompt_tokens;outputTokens+=u.completion_tokens;
 known+=((u.prompt_tokens-cached-written)*pricing.input+cached*pricing.cached_input+written*pricing.cache_write_30m+u.completion_tokens*pricing.output)/1e6;
}
const summary={runId,stage,split,live,started,finished:new Date().toISOString(),prompt_version:version,prompt_hash:hash(prompt),suite_hash:freeze.suite_hash,settings,planned_calls:live?selected.length:0,actual_calls:live?calls:0,unstarted:live?selected.length-calls:0,fatal,
 statuses:records.reduce((m,r)=>(m[r.status]=(m[r.status]??0)+1,m),{}),checks:records.flatMap(r=>r.checks).reduce((m,c)=>(m[c.result]=(m[c.result]??0)+1,m),{}),
 cost:{known_usage_estimate_usd:known,unpriced_calls:unpriced,total_estimate_usd:unpriced?null:known,input_tokens:inputTokens,output_tokens:outputTokens,rate_source:'research/reliability/pricing.json (2026-11-07 historical estimate, not invoice)'},
 records:records.map(r=>({id:r.case_id,status:r.status,checks:r.checks})),notice:suite.notice};
await writeFile(join(directory,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({...summary,records:undefined}));
