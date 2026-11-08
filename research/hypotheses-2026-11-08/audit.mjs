import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {hash,validateReview,validateChecklist} from '../../src/domain.js';
import {validateDialogFacts} from '../../src/ai/facts.js';
import {calculate} from '../../src/scoring.js';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const freeze=await json(new URL('./freeze.json',import.meta.url)),suite=await json(new URL('./cases.frozen.json',import.meta.url));
assert.equal(hash(suite),freeze.suite_hash);
for(const [p,h] of Object.entries(freeze.source_hashes))assert.equal(createHash('sha256').update(await readFile(p)).digest('hex'),h,`Protected source changed: ${p}`);
const packageManifest=await json('package-manifest.json');
for(const f of packageManifest.files)assert.equal(createHash('sha256').update(await readFile(f.path)).digest('hex'),f.sha256,`Original package file changed: ${f.path}`);
const candidateFreeze=await json(new URL('./candidate.freeze.json',import.meta.url));
assert.equal(createHash('sha256').update(await readFile(new URL('./candidate.json',import.meta.url))).digest('hex'),candidateFreeze.candidate_sha256);
const root=resolve('data/hypotheses-2026-11-08'),stages=[];
for(const d of await readdir(root,{withFileTypes:true})){
 if(!d.isDirectory())continue;
 const directory=join(root,d.name);let summary;try{summary=await json(join(directory,'summary.json'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
 const plan=await json(join(directory,'plan.json')),snapshot=await json(join(directory,'input.snapshot.json'));
 assert.equal(summary.actual_calls,summary.planned_calls-summary.unstarted);assert.equal(plan.prompt_hash,summary.prompt_hash);
 const records=[];let quotes=0,ranges=0,partial=0;
 for(const f of (await readdir(directory)).filter(f=>f.endsWith('.record.json'))){
  const stem=f.split('.')[0],r=await json(join(directory,f));records.push(r);
  const source=snapshot.cases.find(c=>c.id===r.case_id);assert.ok(source);assert.deepEqual(r.conversation,source.conversation);
  const expectedSource=summary.split==='invariance'?(await json(new URL('./invariance.frozen.json',import.meta.url))).cases.find(c=>c.id===r.case_id):suite.cases.find(c=>c.id===r.case_id);
  if(summary.split!=='dev'){assert.ok(expectedSource);assert.deepEqual(source.expected,expectedSource.expected);assert.deepEqual(source.conversation,expectedSource.conversation);}
  assert.equal(hash(r.conversation),r.conversation_hash);assert.equal(hash(r.checklist),r.checklist_hash);validateChecklist(r.checklist);
  assert.equal(r.prompt_hash,plan.prompt_hash);assert.equal(r.run_id,plan.runId);
  const request=await json(join(directory,`${stem}.request.json`));assert.equal(hash(request.messages[0].content),plan.prompt_hash);
  const data=JSON.parse(request.messages[1].content);assert.deepEqual(Object.keys(data).sort(),['checklist','conversation','verified_reference'].sort());
  assert.equal(data.verified_reference,null);assert.deepEqual(data.conversation.transcript,r.conversation.transcript);
  assert.deepEqual(data.checklist,r.checklist);assert.ok(!Object.hasOwn(data.conversation,'audio_url'));
  if(r.review){
   validateReview(r.review,r.checklist,r.conversation);validateDialogFacts(r.dialog_facts,r.conversation);
   assert.deepEqual(r.score,calculate(r.checklist,r.review,r.conversation.channel));
   assert.equal(r.status,r.score.status);if(r.status==='partial')partial++;
   for(const row of r.review.criteria){quotes+=row.evidence.length;ranges+=row.checked_ranges.length;}
   const raw=await json(join(directory,`${stem}.response.json`));
   const payload=JSON.parse(raw.choices[0].message.content);assert.deepEqual(r.checklist.criteria.map(c=>payload.evaluations.criteria_by_id[c.id]),r.review.criteria);
   assert.deepEqual(payload.dialog_facts,r.dialog_facts);
  }else assert.equal(r.status,'failed');
  for(const check of r.checks){const expected=source.expected[check.id],actual=r.review?.criteria.find(c=>c.criterion_id===check.id);assert.deepEqual(check.values,expected.values);assert.equal(check.value,actual?.status==='resolved'?actual.value:null);}
 }
 assert.equal(records.length,summary.actual_calls);
 const clear=records.flatMap(r=>r.checks).filter(c=>!c.disputed),disputed=records.flatMap(r=>r.checks).filter(c=>c.disputed);
 stages.push({stage:summary.stage,split:summary.split,calls:summary.actual_calls,statuses:summary.statuses,clear_checks:clear.length,clear_matches:clear.filter(c=>c.result==='match').length,
  disputed_checks:disputed.length,disputed_values:records.flatMap(r=>r.checks.filter(c=>c.disputed).map(c=>({case_id:r.case_id,...c}))),
  mismatches:records.flatMap(r=>r.checks.filter(c=>['mismatch','unexpected_unresolved','failed'].includes(c.result)).map(c=>({case_id:r.case_id,...c}))),
  quotes,ranges,partial,cost:summary.cost,prompt_hash:summary.prompt_hash,prompt_version:summary.prompt_version});
}
const total={calls:stages.reduce((n,s)=>n+s.calls,0),known_usage_estimate_usd:stages.reduce((n,s)=>n+s.cost.known_usage_estimate_usd,0),unpriced_calls:stages.reduce((n,s)=>n+s.cost.unpriced_calls,0)};
total.total_estimate_usd=total.unpriced_calls?null:total.known_usage_estimate_usd;
const comparisons=[];
for(const d of ['discovery','holdout','controls','invariance','dev']){
 const b=stages.find(s=>s.stage==='baseline'&&s.split===d),a=stages.find(s=>s.stage==='candidate'&&s.split===d);if(!b||!a)continue;
 const load=async stage=>{const p=join(root,`${stage}-${d}`);return await Promise.all((await readdir(p)).filter(f=>f.endsWith('.record.json')).map(f=>json(join(p,f))));};
 const before=await load('baseline'),after=await load('candidate');
 for(const x of before){const y=after.find(r=>r.case_id===x.case_id);assert.ok(y);assert.deepEqual(x.conversation,y.conversation);assert.deepEqual(x.checklist,y.checklist);
  const changed=(x.review?.criteria??[]).flatMap(c=>{const z=y.review?.criteria.find(v=>v.criterion_id===c.criterion_id);return !z||c.status!==z.status||c.value!==z.value?[{criterion_id:c.criterion_id,before:c.value,before_status:c.status,after:z?.value??null,after_status:z?.status??null,before_explanation:c.explanation,after_explanation:z?.explanation??y.error}]:[];});
  comparisons.push({split:d,id:x.case_id,status_before:x.status,status_after:y.status,changed});
 }
}
// The nine historical DEV reviews are reused, not re-run as a full DEV baseline.
const devStage=stages.find(s=>s.stage==='candidate'&&s.split==='dev');
if(devStage){
 const input=await json('data/reliability/ten-disagreements/input.json'),dir=join(root,'candidate-dev');
 const current=await Promise.all((await readdir(dir)).filter(f=>f.endsWith('.record.json')).map(f=>json(join(dir,f))));
 for(const c of input.cases){
  const b=await json(`data/${c.evaluation_id}.json`),a=current.find(r=>r.case_id===c.id);assert.ok(a);
  assert.deepEqual(b.conversation.transcript,a.conversation.transcript);assert.deepEqual(b.checklist,a.checklist);assert.equal(b.reference_hash,hash(''));
  const changed=b.ai_review.criteria.flatMap(x=>{const y=a.review?.criteria.find(r=>r.criterion_id===x.criterion_id);return !y||x.value!==y.value||x.status!==y.status?[{criterion_id:x.criterion_id,before:x.value,before_status:x.status,after:y?.value??null,after_status:y?.status??null,before_explanation:x.explanation,after_explanation:y?.explanation??a.error}]:[];});
  comparisons.push({split:'dev-historical',id:c.id,status_before:b.status,status_after:a.status,changed});
 }
}
const audit={notice:suite.notice,protected_source_hashes_unchanged:true,original_package_files_unchanged:packageManifest.files.length,pdf_pages_read:[1,2,3],stages,total,comparisons};
await writeFile(new URL('./audit.json',import.meta.url),JSON.stringify(audit,null,2)+'\n');
console.log(JSON.stringify({stages:stages.map(s=>({stage:s.stage,split:s.split,calls:s.calls,statuses:s.statuses,clear_checks:`${s.clear_matches}/${s.clear_checks}`,disputed:s.disputed_checks,mismatches:s.mismatches.map(m=>({id:m.case_id,criterion:m.id,result:m.result,value:m.value}))})),total,changed_cases:comparisons.filter(c=>c.changed.length).length,original_package_files_unchanged:packageManifest.files.length},null,2));
