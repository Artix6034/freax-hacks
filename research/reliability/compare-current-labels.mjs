// Offline, versioned comparison. Never rewrites labels, prompts or evaluated verdicts.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {importConversations,hash} from '../../src/domain.js';
import {buildSubmission} from '../../src/submission.js';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const sha=text=>createHash('sha256').update(text).digest('hex');
const id=process.argv[2];assert.match(id??'',/^[0-9a-f-]{36}$/);
const previousId='608e0e6b-72f4-4ea6-b34f-3c1bbaa04704';
const paths={labels:'data/annotations/dev65.ai-provisional.jsonl',suite:'research/pdf-04-06-07/cases.json',recap:'research/pdf-04-06-07/chat-recap-validation.json',review:'research/pdf-04-06-07/review-notes.json'};
const raw=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([k,p])=>[k,await readFile(p,'utf8')])));
const labels=raw.labels.trim().split(/\r?\n/).map(JSON.parse),suite=JSON.parse(raw.suite),recap=JSON.parse(raw.recap),review=JSON.parse(raw.review);
const dataset=await read('data/dev/api-response.json'),source=new Map(importConversations(dataset).map(c=>[c.conversation_id,c]));
const indexed=new Map((await readFile('data/dev/indexed-transcripts.jsonl','utf8')).trim().split(/\r?\n/).map(JSON.parse).map(r=>[r.conversation_id,r]));
assert.equal(labels.length,65);assert.equal(new Set(labels.map(r=>r.conversation_id)).size,65);
const original=new Map(),working=new Map(),changes=[],disputes=new Map();
let filled=0,flagged=0;
for(const r of labels){assert.equal(r.annotation_source,'data_chat_ai');assert.equal(r.transcript_hash,indexed.get(r.conversation_id).transcript_hash);
 assert.equal(r.criteria.length,8);assert.equal(new Set(r.criteria.map(c=>c.criterion_id)).size,8);
 for(const c of r.criteria){const key=`${r.conversation_id}:${c.criterion_id}`;if(c.value!==null)filled++;if(c.needs_review&&c.value!==null)flagged++;
  const entry={conversation_id:r.conversation_id,criterion_id:c.criterion_id,value:c.value,known:c.value!==null&&!c.needs_review,needs_review:c.needs_review,explanation:c.explanation,provenance:paths.labels};
  original.set(key,entry);working.set(key,structuredClone(entry));
 }
}
function expect(cid,criterion,values,provenance,authority,reason){
 assert.equal(values.length,1);const key=`${cid}:${criterion}`,before=working.get(key);assert.ok(before);
 if(!before.known||before.value!==values[0])changes.push({key,previous_value:before.value,previous_known:before.known,value:values[0],provenance,authority});
 working.set(key,{...before,value:values[0],known:true,needs_review:false,provenance,authority,original_explanation:before.original_explanation??before.explanation,explanation:reason??`Рабочее ожидание из ${provenance}; прежнее объяснение JSONL не является обоснованием пересмотренной метки.`});
}
// Frozen diagnostic expectations predate the full run. Later review notes supersede them explicitly.
for(const c of suite.dev){for(const [criterion,values] of Object.entries(c.expected))expect(c.id,criterion,values,paths.suite,c.authority??'Assistant development interpretation, not independent human GT.');
 for(const [criterion,values] of Object.entries(c.disputed??{}))disputes.set(`${c.id}:${criterion}`,{values,provenance:paths.suite});}
for(const c of recap.dev)for(const [criterion,values] of Object.entries(c.expected))expect(c.id,criterion,values,paths.recap,recap.notice);
for(const c of review.confirmed_checks)expect(c.case_id,c.criterion_id,c.working_values,paths.review,c.authority,c.reason);
for(const c of review.disputed_checks)disputes.set(`${c.case_id}:${c.criterion_id}`,{values:c.working_values,provenance:paths.review,authority:c.authority});
for(const [key,d] of disputes){const e=working.get(key);assert.ok(e);working.set(key,{...e,known:false,disputed:d});}
async function loadRun(runId){const run=await read(`data/runs/${runId}.json`);assert.equal(run.status,'completed');assert.equal(run.tasks.length,65);
 const records=await Promise.all(run.tasks.map(t=>read(`data/${t.evaluation_id}.json`)));
 for(const r of records){assert.equal(r.run_id,runId);assert.equal(r.configuration_hash,run.configuration_hash);assert.deepEqual(r.conversation,source.get(r.conversation.conversation_id));}
 return {run,records};}
const latest=await loadRun(id),previous=await loadRun(previousId);
const official=await read('results/dev/results.json');assert.deepEqual(buildSubmission({dataset,subset:'dev',evaluations:latest.records,runId:id}).document,official);
function compare(reference,{run,records}){
 const metrics={},differences=[],disputed=[];let referenceKnown=0,bothKnown=0,matches=0,unavailable=0,unknown=0;
 for(const r of records)for(const c of r.checklist.criteria){const key=`${r.conversation.conversation_id}:${c.id}`,a=reference.get(key),b=r.ai_review?.criteria.find(x=>x.criterion_id===c.id);
  assert.ok(a);const known=b?.status==='resolved';if(!known)unknown++;
  const m=metrics[c.id]??={reference_known:0,both_known:0,matches:0,differences:0,unavailable:0};
  if(a.disputed){disputed.push({key,acceptable_hypotheses:a.disputed.values,runtime_value:known?b.value:null,within_hypotheses:known?a.disputed.values.includes(b.value):null,provenance:a.disputed.provenance,explanation:b?.explanation});}
  if(!a.known)continue;referenceKnown++;m.reference_known++;
  if(known){bothKnown++;m.both_known++;if(a.value===b.value){matches++;m.matches++;continue;}m.differences++;}else{unavailable++;m.unavailable++;}
  differences.push({key,channel:r.conversation.channel,expected:a.value,actual:known?b.value:null,kind:known?'different_verdict':'runtime_unknown',reference_provenance:a.provenance,reference_explanation:a.explanation,runtime_explanation:b?.explanation??r.error,missing_information:b?.missing_information??[]});
 }
 assert.equal(referenceKnown,bothKnown+unavailable);assert.equal(differences.length,bothKnown-matches+unavailable);
 for(const m of Object.values(metrics)){assert.equal(m.reference_known,m.both_known+m.unavailable);assert.equal(m.both_known,m.matches+m.differences);}
 return {run_id:run.run_id,prompt:run.execution.prompt_version,reference_known:referenceKnown,both_known:bothKnown,matches,different_known:bothKnown-matches,runtime_unavailable_on_known:unavailable,runtime_unknown_total:unknown,agreement:bothKnown?matches/bothKnown:null,metrics,differences,disputed};
}
const reports={original_current:compare(original,latest),original_previous:compare(original,previous),working_current:compare(working,latest),working_previous:compare(working,previous)};
const notice='Agreement with provisional AI labels and development interpretations, not independent accuracy or official GT. Working labels and prompt were revised using familiar DEV cases. Disputes are excluded from point-label metrics.';
const report={notice,run_id:id,previous_run_id:previousId,source_files:Object.fromEntries(Object.entries(paths).map(([k,path])=>[k,{path,sha256:sha(raw[k])}])),filled_labels:filled,filled_but_needs_review:flagged,changes,disputed_positions:[...disputes.keys()],reports};
const out=`data/dev-label-comparison/${id}`;await mkdir(out,{recursive:true});
for(const [key,text] of Object.entries(raw)){const file=`${out}/${key}.snapshot.txt`;try{await writeFile(file,text,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(await readFile(file,'utf8'),text,'Input changed: preserve a new version rather than overwriting the snapshot.');}}
await writeFile(`${out}/comparison.json`,JSON.stringify(report,null,2));
await writeFile(`${out}/working-reference.json`,JSON.stringify({notice,source_files:report.source_files,positions:[...working.values()]},null,2));
const pct=n=>(n*100).toFixed(2)+'%';
const lines=['Freax — сверка DEV 1.6.1 с исходными и пересмотренными метками',notice,
 `В исходном JSONL: ${filled} заполненных значений, ${flagged} из них needs_review. Исходная строгая база: ${reports.original_current.reference_known}.`,
 'Оба прогона сравниваются с одним и тем же зафиксированным снимком разметки.',
 ...Object.entries(reports).map(([name,r])=>`${name}: ${r.matches}/${r.both_known} (${pct(r.agreement)}); расхождений ${r.different_known}, runtime unknown при известной метке ${r.runtime_unavailable_on_known}.`),
 '', 'Текущий прогон по критериям: исходная база -> рабочая после обсуждений',
 ...Object.keys(reports.original_current.metrics).map(k=>{const a=reports.original_current.metrics[k],b=reports.working_current.metrics[k];return `${k}: ${a.matches}/${a.both_known} -> ${b.matches}/${b.both_known}; расхождений ${b.differences}, недоступно ${b.unavailable}.`;}),
 '', 'Изменения рабочих меток (исходный JSONL не переписан):',...changes.map(c=>`${c.key}: ${c.previous_value}${c.previous_known?'':' [неоднозначно]'} -> ${c.value}; ${c.provenance}.`),
 '', 'Оставшиеся расхождения с однозначной рабочей базой:',...reports.working_current.differences.map(d=>`${d.key}: метка ${d.expected}, модель ${d.actual}; ${d.kind}. ${d.runtime_explanation}`),
 '', 'Спорные позиции — вне подсчёта точных совпадений:',...reports.working_current.disputed.map(d=>`${d.key}: гипотезы ${d.acceptable_hypotheses.join('/')}, модель ${d.runtime_value}; ${d.explanation}`),
 '', 'Не пересчитывались AI-оценки, не менялись промпт, исходная разметка или results.json. Новых API-вызовов нет. Полные источники и их хеши — comparison.json.'];
await writeFile(`${out}/comparison.txt`,lines.join('\n')+'\n');
console.log(JSON.stringify({notice,output:out,filled,flagged,working_changes:changes.length,disputes:disputes.size,results:Object.fromEntries(Object.entries(reports).map(([k,{differences,disputed,metrics,...r}])=>[k,{...r,metrics}]))}));
