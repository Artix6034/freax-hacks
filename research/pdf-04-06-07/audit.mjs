import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {hash,validateReview} from '../../src/domain.js';
import {validateDialogFacts} from '../../src/ai/facts.js';
import {calculate} from '../../src/scoring.js';

const root=resolve('data/rubric-regression'),json=async p=>JSON.parse(await readFile(p,'utf8'));
const before=await json(join(root,'before/report.json')),after=await json(join(root,'after/report.json'));
const followup=[];
for(const stage of ['confirmed','clarification','shared','validate','recap']){
 try{const r=await json(join(root,stage,'report.json'));assert.ok(r.completed_at);followup.push(r);}catch(e){if(e.code!=='ENOENT')throw e;}
}
assert.ok(before.completed_at&&after.completed_at);
assert.equal(before.suite_hash,after.suite_hash);assert.equal(before.checklist_hash,after.checklist_hash);assert.deepEqual(before.settings,after.settings);
const suite=await json('research/pdf-04-06-07/cases.json');assert.equal(after.suite_hash,hash(suite));
const interpretationReview=await json('research/pdf-04-06-07/review-notes.json');
const dispute=(caseId,id)=>interpretationReview.disputed_checks.find(c=>c.case_id===caseId&&c.criterion_id===id);
const pricing=await json('research/reliability/pricing.json');
const findings=[],records=new Map(),sources={criterion_quotes:0,criterion_ranges:0,fact_quotes:0,fact_ranges:0},cost={known_usage_usd:0,unknown_usage_calls:0,input_tokens:0,output_tokens:0},runs=[];
for(const report of [before,after,...followup]){
 assert.equal(report.checklist_hash,after.checklist_hash);assert.deepEqual(report.settings,after.settings);
 assert.equal(report.model_calls,report.planned_calls);assert.equal(report.attempts.length,report.planned_calls);
 for(const item of report.attempts){
  const r=await json(join(root,report.stage,'evaluations',item.evaluation_id+'.json'));records.set(item.evaluation_id,r);
  assert.equal(r.run_id,report.run_id);assert.equal(r.prompt_version,report.prompt_version);assert.equal(r.ai_metadata.prompt_hash,report.prompt_hash);
  assert.equal(hash(r.execution_snapshot),r.configuration_hash);assert.equal(r.execution_snapshot.prompt_hash,report.prompt_hash);
  assert.equal(hash(r.checklist),report.checklist_hash);assert.equal(r.ai_metadata.attempts,1);assert.equal(r.ai_metadata.calls.length,1);
  assert.equal(r.conversation_hash,hash(r.conversation));assert.equal(r.reference_hash,report.reference_hash);
  if(r.ai_review){
   validateReview(r.ai_review,r.checklist,r.conversation);validateDialogFacts(r.ai_facts,r.conversation);
   assert.deepEqual(r.original_score,calculate(r.checklist,r.ai_review,r.conversation.channel));
   assert.deepEqual(r.ai_review,r.final_review);assert.equal(r.appeals.length,0);
   for(const c of r.ai_review.criteria){sources.criterion_quotes+=c.evidence.length;sources.criterion_ranges+=c.checked_ranges.length;}
   const visit=value=>{if(!value||typeof value!=='object')return;
    if(typeof value.message_id==='string'&&typeof value.quote==='string')sources.fact_quotes++;
    if(typeof value.from_message_id==='string'&&typeof value.to_message_id==='string')sources.fact_ranges++;
    Object.values(value).forEach(child=>Array.isArray(child)?child.forEach(visit):visit(child));};visit(r.ai_facts);
   assert.equal(item.status,r.status);
  }else assert.equal(r.status,'failed');
  const u=r.ai_metadata.usage,cached=u?.prompt_tokens_details?.cached_tokens??0,written=u?.prompt_tokens_details?.cache_write_tokens??0;
  cost.input_tokens+=u?.prompt_tokens??0;cost.output_tokens+=u?.completion_tokens??0;
  if(!u||!Number.isFinite(u.prompt_tokens)||!Number.isFinite(u.completion_tokens)||u.prompt_tokens<cached+written||u.prompt_tokens>272000)cost.unknown_usage_calls++;
  else cost.known_usage_usd+=((u.prompt_tokens-cached-written)*pricing.input+cached*pricing.cached_input+written*pricing.cache_write_30m+u.completion_tokens*pricing.output)/1e6;
 }
 const rawChecks=report.attempts.flatMap(a=>a.checks);
 const checks=report.attempts.flatMap(a=>a.checks.filter(c=>!dispute(a.case_id,c.id)));
 runs.push({stage:report.stage,prompt_version:report.prompt_version,calls:report.model_calls,completed:report.attempts.filter(a=>a.status==='completed').length,
  partial:report.attempts.filter(a=>a.status==='partial').length,failed:report.attempts.filter(a=>a.status==='failed').length,
  raw_target_checks:rawChecks.reduce((m,c)=>(m[c.result]=(m[c.result]??0)+1,m),{}),
  target_checks:checks.reduce((m,c)=>(m[c.result]=(m[c.result]??0)+1,m),{}),
  excluded_as_disputed:report.attempts.flatMap(a=>a.checks.filter(c=>dispute(a.case_id,c.id)).map(c=>({case_id:a.case_id,criterion_id:c.id,raw_result:c.result})))});
}
const synthetic=[];
for(const b of before.attempts){
 const a=after.attempts.find(a=>a.case_id===b.case_id);assert.ok(a);
 const rb=records.get(b.evaluation_id),ra=records.get(a.evaluation_id);
 assert.deepEqual(rb.conversation.transcript,ra.conversation.transcript);assert.equal(rb.conversation.language,ra.conversation.language);
 const target=b.checks[0].id;
 synthetic.push({case_id:b.case_id,target,expected:b.checks[0].expected,before:b.values[target]??null,after:a.values[target]??null,before_result:b.checks[0].result,after_result:a.checks[0].result,
  explanation_before:rb.ai_review?.criteria.find(c=>c.criterion_id===target)?.explanation??rb.error,
  explanation_after:ra.ai_review?.criteria.find(c=>c.criterion_id===target)?.explanation??ra.error,
  changed_other_criteria:Object.keys({...b.values,...a.values}).filter(id=>id!==target&&b.values[id]!==a.values[id]).map(id=>({id,before:b.values[id]??null,after:a.values[id]??null}))});
}
const dev=[];
for(const report of [after,...followup])for(const a of report.attempts.filter(a=>a.kind==='DEV diagnostic')){
 const r=records.get(a.evaluation_id),b=await json(join('data',a.baseline_evaluation_id+'.json'));assert.deepEqual(b.conversation,r.conversation);
 const ids=new Set([...a.checks.map(c=>c.id),...Object.keys(a.disputed)]);
 dev.push({stage:report.stage,prompt_version:report.prompt_version,case_id:a.case_id,repeat_of:a.repeat_of,status:a.status,baseline_evaluation_id:b.evaluation_id,evaluation_id:r.evaluation_id,all_values:a.values,
  comparisons:[...ids].map(id=>{const old=b.ai_review.criteria.find(c=>c.criterion_id===id),fresh=r.ai_review?.criteria.find(c=>c.criterion_id===id);
   const note=dispute(a.case_id,id);
   return {id,expected:note?null:a.checks.find(c=>c.id===id)?.expected??null,disputed:note?.working_values??a.disputed[id]??null,
    raw_expected:a.checks.find(c=>c.id===id)?.expected??null,raw_result:a.checks.find(c=>c.id===id)?.result??null,interpretation_note:note?.reason??null,
    before:old.status==='resolved'?old.value:null,after:fresh?.status==='resolved'?fresh.value:null,
    result:note?'disputed_not_scored':a.checks.find(c=>c.id===id)?.result??'disputed_not_scored',explanation:fresh?.explanation??r.error,
    evidence:fresh?.evidence.map(e=>({...e,timestamp:r.conversation.transcript.find(m=>m.message_id===e.message_id).timestamp}))??[],checked_ranges:fresh?.checked_ranges??[],missing_information:fresh?.missing_information??[]};}),
  unresolved:r.ai_review?.criteria.filter(c=>c.status==='unresolved').map(c=>({id:c.criterion_id,missing_information:c.missing_information}))??[]});
}
for(const item of [...synthetic,...dev]){
 const checks=item.comparisons??[{id:item.target,result:item.after_result,expected:item.expected,after:item.after}];
 for(const c of checks)if(['mismatch','unresolved','failed'].includes(c.result))findings.push({stage:item.stage??'after',case_id:item.case_id,...c});
}
const followupControls=followup.flatMap(report=>report.attempts.filter(a=>a.kind!=='DEV diagnostic').map(a=>({stage:report.stage,prompt_version:report.prompt_version,...a,
 explanations:records.get(a.evaluation_id).ai_review?.criteria.filter(c=>a.checks.some(x=>x.id===c.criterion_id)).map(c=>({id:c.criterion_id,explanation:c.explanation,evidence:c.evidence,checked_ranges:c.checked_ranges}))??[]})));
for(const c of followupControls)for(const check of c.checks)if(check.result!=='match')findings.push({stage:c.stage,case_id:c.case_id,...check});
const latest=new Map();
for(const report of [after,...followup])for(const a of report.attempts)for(const c of a.checks)latest.set(`${a.case_id}:${c.id}`,{stage:report.stage,case_id:a.case_id,...c});
const latestFindings=[...latest.values()].filter(c=>c.result!=='match'&&!dispute(c.case_id,c.id));
const sharedComparisons=[];
const sharedCost={known_usage_usd:0,unknown_usage_calls:0,input_tokens:0,output_tokens:0};
const historical=[before,after,...followup.filter(r=>r.stage!=='shared')];
for(const item of followup.find(r=>r.stage==='shared')?.attempts??[]){
 const current=records.get(item.evaluation_id);
 const u=current.ai_metadata?.usage,cached=u?.prompt_tokens_details?.cached_tokens??0,written=u?.prompt_tokens_details?.cache_write_tokens??0;
 sharedCost.input_tokens+=u?.prompt_tokens??0;sharedCost.output_tokens+=u?.completion_tokens??0;
 if(!u||!Number.isFinite(u.prompt_tokens)||!Number.isFinite(u.completion_tokens)||u.prompt_tokens<cached+written||u.prompt_tokens>272000)sharedCost.unknown_usage_calls++;
 else sharedCost.known_usage_usd+=((u.prompt_tokens-cached-written)*pricing.input+cached*pricing.cached_input+written*pricing.cache_write_30m+u.completion_tokens*pricing.output)/1e6;
 const previous=historical.flatMap(report=>report.attempts.filter(a=>a.case_id===item.case_id).map(a=>({report,item:a}))).at(-1);
 const old=previous?records.get(previous.item.evaluation_id):item.baseline_evaluation_id?await json(join('data',item.baseline_evaluation_id+'.json')):null;
 if(old){assert.deepEqual(old.conversation.transcript,current.conversation.transcript);assert.deepEqual(old.checklist,current.checklist);}
 sharedComparisons.push({case_id:item.case_id,reference_prompt:old?.prompt_version??null,current_prompt:current.prompt_version,
  reference_type:previous?'saved historical experiment':old?'saved DEV 1.3':'new synthetic case; no baseline',checks:item.checks,
  changes:old?current.ai_review?.criteria.filter(c=>old.ai_review?.criteria.some(o=>o.criterion_id===c.criterion_id&&o.value!==c.value)).map(c=>({id:c.criterion_id,before:old.ai_review.criteria.find(o=>o.criterion_id===c.criterion_id).value,after:c.value,explanation:c.explanation})):[],
  status:current.status,error:current.error??null});
}
const repeats=[after,...followup].flatMap(report=>report.attempts.filter(b=>b.repeat_of).map(b=>{
 const a=report.attempts.find(a=>a.case_id===b.repeat_of);assert.ok(a);
 return {stage:report.stage,id:b.repeat_of,checks:Object.keys({...a.values,...b.values}).map(c=>({id:c,first:a.values[c]??null,second:b.values[c]??null,same:a.values[c]===b.values[c]}))};
}));
const summary={notice:'Development diagnostics and assistant/user working interpretations only; no official or independent human GT. Not an accuracy estimate.',
 versions:{before:before.prompt_version,after:after.prompt_version,current:followup.at(-1)?.prompt_version??after.prompt_version},runs,synthetic,dev,repeats,findings,latest_findings:latestFindings,shared_comparisons:sharedComparisons,shared_cost:{...sharedCost,estimated_usd:sharedCost.unknown_usage_calls?null:sharedCost.known_usage_usd},followup_controls:followupControls,interpretation_review:interpretationReview,
 source_validation:sources,cost:{...cost,estimated_usd:cost.unknown_usage_calls?null:cost.known_usage_usd,pricing_source:pricing.source??'research/reliability/pricing.json',notice:'Estimate at saved Standard pricing, not a provider invoice.'},
 limitations:['Synthetic fixtures are development cases, not unseen test data. KZ needs native review.','Synthetic transcript text, roles and timestamps are identical between stages; anonymous conversation_id differs.','DEV baseline uses the saved previous run with matching transcript/checklist and model settings, not a simultaneous repeated A/B test.','Unresolved and failed checks are not counted as correct; disputed interpretations are not forced into a single GT.','A verified quote proves that text exists, not that the semantic verdict is correct.','Live web service is not restarted and official submission files are not rewritten.']};
await writeFile(join(root,'comparison.json'),JSON.stringify(summary,null,2));
const fmt=v=>v===null?'unknown':Array.isArray(v)?v.join('|'):String(v);
const lines=['Freax — проверка 04, 06, 07 по PDF',summary.notice,`${before.prompt_version} → ${after.prompt_version}`,'',
 ...runs.map(r=>JSON.stringify(r)), '', 'ПАРНЫЕ ПРИМЕРЫ И КОНТРОЛИ',
 ...synthetic.map(x=>`${x.case_id}: ожидание ${fmt(x.expected)}; ${fmt(x.before)} → ${fmt(x.after)} (${x.after_result}). ${x.explanation_after}`),
 '', 'DEV (спорные трактовки не входят в число совпадений)',
 ...dev.flatMap(d=>[`${d.stage} / ${d.case_id}: ${d.status}; запись ${d.evaluation_id}`,...d.comparisons.map(c=>`  ${c.id}: ${fmt(c.before)} → ${fmt(c.after)}; ${c.result}; ${c.explanation}`),...d.unresolved.map(u=>`  unknown ${u.id}: ${u.missing_information.join('; ')}`)]),
 '', 'ДОПОЛНИТЕЛЬНЫЕ КОНТРОЛИ',...followupControls.map(c=>`${c.stage} / ${c.case_id}: ${JSON.stringify(c.checks)}; ${JSON.stringify(c.explanations)}`),
 '', 'ПОВТОРЫ',...repeats.map(r=>`${r.id}: изменились ${r.checks.filter(c=>!c.same).map(c=>`${c.id} ${fmt(c.first)} → ${fmt(c.second)}`).join(', ')||'нет изменений'}`),
 '', `Исторические несовпадения/ошибки: ${findings.length}; остаточные после последних проверок: ${latestFindings.length}.`, `Источники: ${JSON.stringify(sources)}.`, `Стоимость: ${JSON.stringify(summary.cost)}.`, '',...summary.limitations];
await writeFile(join(root,'report.txt'),lines.join('\n')+'\n');
console.log(JSON.stringify({runs,latest_findings:latestFindings,shared_comparisons:sharedComparisons,source_validation:sources,cost:summary.cost},null,2));
