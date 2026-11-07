// All scores/transcripts here are ARTIFICIAL FORMAT FIXTURES, never DEV or GT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { normalizeConversation, hash } from '../src/domain.js';
import { calculate } from '../src/scoring.js';
import { buildSubmission, validateSubmission, submissionDataset, submissionSchema, SUBMISSION_CRITERIA } from '../src/submission.js';

const original=JSON.parse(await readFile(new URL('../config/checklist.v1.json',import.meta.url),'utf8'));
const updated=JSON.parse(await readFile(new URL('../config/checklist.organizer-2026-11-07.json',import.meta.url),'utf8'));
const project=fileURLToPath(new URL('../',import.meta.url));
const script=fileURLToPath(new URL('../scripts/export-results.mjs',import.meta.url));
const values=['yes','na','na',15,'yes',7,'yes','no']; // Appendix's artificial 85.38 arithmetic.

function source(i,voice=false){
  const roles=['client','bot','system','operator','operator','operator','client','operator'];
  const texts=['ИСКУССТВЕННЫЙ ТЕСТ: Где инструкция?','ИСКУССТВЕННЫЙ ТЕСТ: Я бот.','ИСКУССТВЕННЫЙ ТЕСТ: Передан оператору.',
    'Здравствуйте! Я Анна. ИСКУССТВЕННЫЙ ТЕСТ.','ИСКУССТВЕННЫЙ ТЕСТ: первый шаг.','ИСКУССТВЕННЫЙ ТЕСТ: второй шаг.',
    'ИСКУССТВЕННЫЙ ТЕСТ: Спасибо.','ИСКУССТВЕННЫЙ ТЕСТ: итог. Ещё вопросы? До свидания!'];
  return {conversation_id:`artificial-submit-${String(i+1).padStart(3,'0')}`,channel:voice?'voice call':'agent chat',language:voice?'RU':['RU','KZ','EN'][i%3],audio_url:null,
    transcript:roles.map((speaker,n)=>({speaker,text:texts[n],timestamp:voice?`2026-11-07T12:00:${String(n).padStart(2,'0')}+05:00`:`00:${String(n).padStart(2,'0')}`}))};
}
function review(c,vs=values){
  const assigned=c.criteria.map((s,i)=>i<vs.length?vs[i]:s.type==='scale'?s.scale.at(-1).value:s.type==='flag'?'no':'yes');
  return {criteria:c.criteria.map((s,i)=>({criterion_id:s.id,status:'resolved',value:assigned[i],
    explanation:'ARTIFICIAL FORMAT FIXTURE — not an AI verdict or Ground Truth.',missing_information:[],na_reason:assigned[i]==='na'?'ARTIFICIAL N/A condition.':'',na_condition:'',
    evidence:s.type==='flag'&&assigned[i]==='no'?[]:[{message_id:assigned[i]==='na'?'m0001':'m0004',quote:assigned[i]==='na'?'ИСКУССТВЕННЫЙ ТЕСТ':'Здравствуйте! Я Анна.'}],
    checked_ranges:s.type==='flag'?[{from_message_id:'m0001',to_message_id:'m0008',expected_action:'ARTIFICIAL: whole source checked.'}]:[]}))};
}
function evaluate(conversation,c=original){
  const normalized=normalizeConversation(conversation),r=review(c),score=calculate(c,r,normalized.channel);
  return {evaluation_id:randomUUID(),created_at:'2026-11-07T12:00:00Z',status:'completed',ai_status:'completed',final_status:'completed',
    conversation:normalized,checklist:structuredClone(c),checklist_hash:hash(c),ai_review:r,original_score:score,final_review:structuredClone(r),final_score:structuredClone(score),appeals:[],
    ai_metadata:{provider:'cloud',model:'ARTIFICIAL-FORMAT-FIXTURE-NOT-AI',calls:[{provider:'cloud',requested_model:'ARTIFICIAL-REQUESTED',returned_model:'ARTIFICIAL-FORMAT-FIXTURE-NOT-AI'}]}};
}
function batch(subset='prod',c=original){
  const count=subset==='dev'?65:10,dataset=Array.from({length:count},(_,i)=>source(i,subset==='dev'&&i>=60));
  return {subset,dataset,evaluations:dataset.map(s=>evaluate(s,c))};
}

test('submission refuses mixed prompt/model/reference configurations and isolates a selected run',()=>{
 const b=batch();b.evaluations.forEach(r=>{r.prompt_version='TEST-v1';r.reference_hash='TEST-ref';});
 for(const mutate of [r=>r.prompt_version='TEST-v2',r=>r.reference_hash='different-reference',r=>r.ai_metadata.reasoning_effort='different']){
  const changed=structuredClone(b);mutate(changed.evaluations[0]);assert.throws(()=>buildSubmission(changed),e=>e.code==='MIXED_EXECUTIONS');
 }
 const id=randomUUID();b.evaluations.forEach(r=>r.run_id=id);
 const unrelated=structuredClone(b.evaluations[0]);unrelated.run_id=randomUUID();unrelated.prompt_version='TEST-v2';
 const result=buildSubmission({...b,evaluations:[unrelated,...b.evaluations],runId:id});assert.equal(result.report.run_id,id);assert.equal(result.report.ok_count,10);
 const mixed=structuredClone(b);mixed.evaluations[0].run_id=randomUUID();assert.throws(()=>buildSubmission(mixed),e=>e.code==='MIXED_RUNS');
});
function partial(r,id){
  Object.assign(r.ai_review.criteria.find(c=>c.criterion_id===id),{status:'unresolved',value:null,explanation:'ARTIFICIAL: evidence unavailable.',missing_information:['ARTIFICIAL: dated authoritative rule.'],na_reason:'',evidence:[],checked_ranges:[]});
  r.ai_status='partial';r.status='partial';r.final_status='partial';r.original_score=calculate(r.checklist,r.ai_review,r.conversation.channel);r.final_review=structuredClone(r.ai_review);r.final_score=structuredClone(r.original_score);
}

test('appendix mapping uses booleans, NA null, raw scales and 85.38; Freax is the default',()=>{
  const b=batch('dev'),before=structuredClone(b),{document,report}=buildSubmission(b);
  assert.equal(document.team_name,'Freax');assert.deepEqual(Object.keys(document),['schema_version','team_name','model','results']);
  assert.deepEqual(document.model,{mode:'external_api',name:'ARTIFICIAL-FORMAT-FIXTURE-NOT-AI'});
  assert.equal(document.results.length,65);assert.equal(report.ok_count,65);assert.equal(report.error_count,0);
  const r=document.results[0];assert.equal(r.status,'ok');assert.equal(r.score.final_score,85.38);
  assert.deepEqual(r.criteria.map(c=>c.criterion_id),SUBMISSION_CRITERIA.map(c=>c.code));
  assert.deepEqual(r.criteria.map(c=>c.value),[true,null,null,15,true,7,true,false]);
  assert.equal(r.criteria.find(c=>c.criterion_id==='dialogue').value,7); // not weighted 10.5
  assert.deepEqual(r.criteria[0].evidence_turns,[4]); // bot/system are not removed from numbering
  assert.deepEqual(r.criteria[7].evidence_turns,[1,2,3,4,5,6,7,8]);
  assert.deepEqual(b,before);assert.equal(validateSubmission(document,{dataset:b.dataset,subset:'dev'}).records,65);
});

test('true/false and numeric zero remain distinct; critical does not zero the total',()=>{
  const b=batch(),r=b.evaluations[0];
  r.ai_review=review(original,['no','na','na',0,'no',0,'yes','yes']);r.original_score=calculate(original,r.ai_review);
  const result=buildSubmission(b).document.results[0];
  assert.equal(result.criteria[0].value,false);assert.equal(result.criteria[3].value,0);
  assert.equal(result.criteria[7].value,true);assert.equal(result.score.critical_flag,true);assert.equal(result.score.final_score,7.69);
});

test('inclusive ranges union with quotes and use original positions for every speaker',()=>{
  const b=batch(),row=b.evaluations[0].ai_review.criteria[0];
  row.checked_ranges=[{from_message_id:'m0002',to_message_id:'m0005',expected_action:'ARTIFICIAL checked segment.'}];
  assert.deepEqual(buildSubmission(b).document.results[0].criteria[0].evidence_turns,[2,3,4,5]);
});

test('failed and unresolved records retain IDs as error with no fake NA/zero; source stays intact',()=>{
  const b=batch();b.evaluations[0].ai_status='failed';b.evaluations[0].error='Timeout sk-proj-TEST_ONLY_NOT_A_REAL_KEY_0123456789 https://private.invalid/audio?sig=hidden';
  partial(b.evaluations[1],'04');const before=structuredClone(b);
  const {document,report}=buildSubmission(b);
  assert.equal(report.ok_count,8);assert.equal(report.error_count,2);assert.equal(report.all_scored,false);
  for(const r of document.results.slice(0,2)){assert.equal(r.status,'error');assert.deepEqual(r.criteria,[]);assert.equal(r.score,null);assert.ok(r.error);}
  assert.match(document.results[1].error,/consultation/);assert.doesNotMatch(document.results[0].error,/abcdefghijklmnopqrstuvwxyz|sig=hidden/);
  assert.equal(document.results[1].conversation_id,b.dataset[1].conversation_id);assert.deepEqual(b,before);
});

test('unknown zero-weight critical is an error in submission even with an internal numeric total',()=>{
  const b=batch();partial(b.evaluations[0],'08');assert.equal(b.evaluations[0].original_score.total,85.38);
  const r=buildSubmission(b).document.results[0];assert.equal(r.status,'error');assert.equal(r.score,null);assert.match(r.error,/critical/);
});

test('voice contact NA remains internally valid but cannot become null contact in the official file',()=>{
  const b=batch('dev',updated),r=b.evaluations[60];
  Object.assign(r.ai_review.criteria[0],{value:'na',na_reason:'ARTIFICIAL: late recording start.',na_condition:'recording_started_after_greeting'});
  r.original_score=calculate(r.checklist,r.ai_review,r.conversation.channel);
  const item=buildSubmission(b).document.results[60];assert.equal(item.status,'error');assert.match(item.error,/contact/);
});

test('original partial never inherits a completed human-final result; view must be explicit',()=>{
  const b=batch(),r=b.evaluations[0];partial(r,'04');
  r.final_review=review(original);r.final_score=calculate(original,r.final_review);r.final_status=r.status='completed';
  assert.equal(buildSubmission(b).document.results[0].status,'error');
  const final=buildSubmission({...b,view:'reviewed-final'});assert.equal(final.document.results[0].status,'ok');assert.equal(final.report.source_view,'reviewed-final');
  delete r.ai_status;assert.equal(buildSubmission(b).document.results[0].status,'error');
});

test('source mismatch, invented quote and stale saved arithmetic become explicit errors',()=>{
  const b=batch();b.evaluations[0].conversation.transcript[0].text='DIFFERENT SOURCE';
  b.evaluations[1].ai_review.criteria[0].evidence[0].quote='NOT IN SOURCE';
  b.evaluations[2].original_score.total=1;
  const {document}=buildSubmission(b);assert.deepEqual(document.results.slice(0,3).map(r=>r.status),['error','error','error']);
});

test('missing, duplicate and unexpected IDs block a final export; running attempts block too',()=>{
  const b=batch();assert.throws(()=>buildSubmission({...b,evaluations:b.evaluations.slice(1)}),e=>e.code==='MISSING_EVALUATIONS'&&e.details.missing_count===1);
  assert.throws(()=>buildSubmission({...b,evaluations:[...b.evaluations,b.evaluations[0]]}),e=>e.code==='DUPLICATE_EVALUATION_ID');
  assert.throws(()=>buildSubmission({...b,evaluations:[...b.evaluations,evaluate(source(99))]}),e=>e.code==='UNEXPECTED_ID');
  b.evaluations[0].ai_status='running';assert.throws(()=>buildSubmission(b),e=>e.code==='RUNNING_EVALUATION');
});

test('latest selection is explicit and chooses the latest failed attempt, never an older good one',()=>{
  const b=batch(),failed=structuredClone(b.evaluations[0]);failed.evaluation_id=randomUUID();failed.created_at='2026-11-07T12:01:00Z';failed.ai_status='failed';failed.error='ARTIFICIAL failed latest attempt.';
  const input={...b,evaluations:[failed,...b.evaluations,evaluate(source(99))],latest:true,checklistId:'freedom-chat',checklistVersion:1};
  const result=buildSubmission(input);assert.equal(result.document.results[0].status,'error');assert.equal(result.report.selected_evaluations[0].evaluation_id,failed.evaluation_id);
  assert.equal(result.report.ignored_evaluations,2);
  assert.throws(()=>buildSubmission({...input,checklistVersion:undefined}),e=>e.code==='VERSION_REQUIRED');
});

test('count and channel coverage are mandatory for DEV65 and PROD10',()=>{
  const dev=batch('dev');assert.equal(submissionDataset(dev.dataset,'dev').length,65);
  assert.throws(()=>submissionDataset(dev.dataset.slice(0,60),'dev'),e=>e.code==='DATASET_COUNT');
  const prod=batch();prod.dataset[0]=source(0,true);assert.throws(()=>submissionDataset(prod.dataset,'prod'),e=>e.code==='DATASET_CHANNELS');
  prod.dataset[0]=prod.dataset[1];assert.throws(()=>submissionDataset(prod.dataset,'prod'),e=>e.code==='DUPLICATE_SOURCE_ID');
});

test('mixed snapshots, a ninth criterion or a different scale cannot be silently projected to eight',()=>{
  const b=batch();b.evaluations[0].checklist.version=2;
  assert.throws(()=>buildSubmission(b),e=>e.code==='MIXED_CHECKLISTS');
  const nine=structuredClone(original);nine.criteria.push({...structuredClone(nine.criteria[0]),id:'custom'});
  const n=batch('prod',nine);assert.throws(()=>buildSubmission(n),e=>e.code==='INCOMPATIBLE_CHECKLIST');
  const changed=structuredClone(original);changed.criteria[5].scale.push({value:20,description:'ARTIFICIAL extra step'});changed.criteria[5].allowed_values.push(20);
  assert.throws(()=>buildSubmission(batch('prod',changed)),e=>e.code==='INCOMPATIBLE_CHECKLIST');
});

test('changed weights use the saved current snapshot, not silently the appendix defaults',()=>{
  const c=structuredClone(original);c.version=2;c.criteria[5].weight=12;
  const b=batch('prod',c),{document}=buildSubmission(b);assert.equal(document.results[0].score.final_score,86.13);
  assert.throws(()=>validateSubmission(document,{dataset:b.dataset,subset:'prod'}),e=>e.code==='ARITHMETIC_MISMATCH');
  assert.equal(validateSubmission(document,{dataset:b.dataset,subset:'prod',checklist:c}).valid,true);
});

test('actual returned model names and mixed execution providers are retained',()=>{
  const b=batch();b.evaluations[0].ai_metadata.calls.push({provider:'local',requested_model:'ARTIFICIAL-LOCAL-JUDGE',returned_model:'ARTIFICIAL-LOCAL-JUDGE'});
  const {document}=buildSubmission(b);assert.equal(document.model.mode,'hybrid');assert.match(document.model.name,/ARTIFICIAL-LOCAL-JUDGE/);assert.doesNotMatch(document.model.name,/ARTIFICIAL-REQUESTED/);
});

test('validator rejects wrong codes/types/turns/flags/scores and extra fields without echoing sources',()=>{
  const b=batch(),base=buildSubmission(b).document;
  const mutations=[d=>d.results.pop(),d=>d.results[0].conversation_id=d.results[1].conversation_id,
    d=>d.results[0].criteria[0].criterion_id='01',d=>d.results[0].criteria[1].criterion_id='contact',
    d=>d.results[0].criteria[0].value=null,d=>d.results[0].criteria[0].value='yes',d=>d.results[0].criteria[5].value=8,
    d=>d.results[0].criteria[0].evidence_turns=[0],d=>d.results[0].criteria[0].evidence_turns=[9],
    d=>d.results[0].score.critical_flag=true,d=>d.results[0].score.final_score=85.381,
    d=>d.results[0].score.final_score=0,d=>d.model.mode='cloud',d=>d.audio_url='PRIVATE',
    d=>d.results[0]={conversation_id:d.results[0].conversation_id,status:'error',criteria:[],score:0,error:'ARTIFICIAL'}];
  for(const mutate of mutations){const doc=structuredClone(base);mutate(doc);assert.throws(()=>validateSubmission(doc,{dataset:b.dataset,subset:'prod'}));}
});

test('published JSON Schema stays in sync with the offline submission contract',async()=>{
  const schema=JSON.parse(await readFile(new URL('../contracts/submission.schema.json',import.meta.url),'utf8'));
  assert.deepEqual(schema,submissionSchema());assert.equal(schema.properties.results.items.oneOf[0].properties.criteria.minItems,8);
});

async function tempFolder(fn){
  const folder=await mkdtemp(join(tmpdir(),'cqa-submission-test-'));
  try{return await fn(folder);}finally{
    const path=resolve(folder);assert.equal(dirname(path),resolve(tmpdir()));assert.ok(path.startsWith(join(resolve(tmpdir()),'cqa-submission-test-')));
    await rm(path,{recursive:true,force:true});
  }
}
const cli=(args,cwd=project)=>spawnSync(process.execPath,[script,...args],{cwd,encoding:'utf8',timeout:20000});

test('CLI exports UTF-8 DEV/PROD and validates the actual saved files with correct paths',async()=>tempFolder(async folder=>{
  for(const subset of ['dev','prod']){
    const c=structuredClone(original);if(subset==='prod')c.criteria[5].weight=12;
    const b=batch(subset,c),dataset=join(folder,subset+'-source.json'),evaluations=join(folder,subset+'-evaluations.json'),checklist=join(folder,subset+'-checklist.json'),output=join(folder,'results',subset,'results.json');
    await writeFile(dataset,JSON.stringify({isSuccess:true,data:{records:b.dataset}}),'utf8');await writeFile(evaluations,JSON.stringify(b.evaluations),'utf8');await writeFile(checklist,JSON.stringify(c),'utf8');
    const args=['export','--subset',subset,'--dataset',dataset,'--evaluations',evaluations,'--output',output];
    const exported=cli(args,folder);assert.equal(exported.status,0,exported.stderr);assert.equal(JSON.parse(exported.stdout).status,'exported');
    const bytes=await readFile(output);assert.notDeepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf]);assert.match(bytes.toString('utf8'),/ARTIFICIAL/);
    const validated=cli(['validate','--subset',subset,'--dataset',dataset,'--input',output,'--checklist',checklist],folder);assert.equal(validated.status,0,validated.stderr);
    assert.equal(JSON.parse(validated.stdout).records,subset==='dev'?65:10);
    const good=await readFile(output);await writeFile(evaluations,JSON.stringify(b.evaluations.slice(1)),'utf8');
    const blocked=cli(args,folder);assert.equal(blocked.status,2);assert.equal(JSON.parse(blocked.stderr).code,'MISSING_EVALUATIONS');assert.deepEqual(await readFile(output),good);
  }
}));

test('CLI readiness does not create submission files and invalid UTF-8 is rejected',async()=>tempFolder(async folder=>{
  const b=batch(),dataset=join(folder,'dataset.json'),evaluations=join(folder,'evaluations.json');
  await writeFile(dataset,JSON.stringify(b.dataset),'utf8');await writeFile(evaluations,JSON.stringify(b.evaluations),'utf8');
  const ready=cli(['readiness','--subset','prod','--dataset',dataset,'--evaluations',evaluations],folder);assert.equal(ready.status,0,ready.stderr);assert.equal(JSON.parse(ready.stdout).status,'ready_for_export');
  await assert.rejects(()=>access(join(folder,'results','prod','results.json')));
  await writeFile(dataset,Buffer.from([0xff,0xfe,0xff]));
  const blocked=cli(['readiness','--subset','prod','--dataset',dataset,'--evaluations',evaluations],folder);assert.equal(blocked.status,2);assert.equal(JSON.parse(blocked.stderr).code,'INVALID_JSON');
}));
