import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {importConversations,hash} from '../../src/domain.js';
import {Store} from '../../src/store.js';

const id=process.argv[2]||'608e0e6b-72f4-4ea6-b34f-3c1bbaa04704';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const run=await read(join('data/runs',id+'.json'));assert.equal(run.status,'completed');
const baselineFile='data/annotations/dev65.ai-provisional.jsonl',baseline=(await readFile(baselineFile,'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
const indexed=(await readFile('data/dev/indexed-transcripts.jsonl','utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
const sources=new Map(importConversations(await read('data/dev/api-response.json')).map(c=>[c.conversation_id,c]));
const original=await read('config/checklist.v1.json'),split=await read('research/dev-split-v1.json'),store=new Store('data');
assert.equal(baseline.length,65);assert.equal(new Set(baseline.map(c=>c.conversation_id)).size,65);assert.equal(run.tasks.length,65);
assert.ok(baseline.every(c=>c.annotation_source==='data_chat_ai'&&c.annotation_status==='ai_provisional'));
const reference=new Map(baseline.map(c=>[c.conversation_id,c])),metrics={},rows=[];
for(const c of run.checklist.criteria)metrics[c.id]={id:c.id,name:c.name,total:0,reference_known:0,runtime_known_on_reference:0,exact_agreements:0,both_known_differences:0,reference_unknown:0,runtime_unresolved:0,runtime_failed:0,matrix:{},absolute_scale_differences:[]};
for(const task of run.tasks){
 const r=await store.read(task.evaluation_id),ref=reference.get(task.conversation_id),index=indexed.find(i=>i.conversation_id===task.conversation_id);
 assert.ok(ref&&index);assert.equal(ref.transcript_hash,index.transcript_hash);assert.deepEqual(r.conversation,sources.get(task.conversation_id));
 for(const criterion of run.checklist.criteria){
  const def=original.criteria.find(c=>c.id===criterion.id),a=ref.criteria.find(c=>c.criterion_id===criterion.id),b=r.ai_review?.criteria.find(c=>c.criterion_id===criterion.id);
  const referenceKnown=Boolean(a&&!a.needs_review&&def.allowed_values.includes(a.value));
  const runtimeKnown=Boolean(b&&b.status==='resolved'&&criterion.allowed_values.includes(b.value));
  const referenceState=referenceKnown?String(a.value):'unresolved',runtimeState=r.status==='failed'?'failed':runtimeKnown?String(b.value):'unresolved',m=metrics[criterion.id];
  m.total++;if(referenceKnown)m.reference_known++;else m.reference_unknown++;
  if(runtimeState==='failed')m.runtime_failed++;else if(!runtimeKnown)m.runtime_unresolved++;
  (m.matrix[referenceState]??={})[runtimeState]=((m.matrix[referenceState]??{})[runtimeState]??0)+1;
  const bothKnown=referenceKnown&&runtimeKnown,agree=bothKnown&&a.value===b.value;
  if(bothKnown){m.runtime_known_on_reference++;if(agree)m.exact_agreements++;else m.both_known_differences++;
    if(typeof a.value==='number'&&typeof b.value==='number')m.absolute_scale_differences.push(Math.abs(b.value-a.value));}
  if(!agree){
   const kind=bothKnown?'different_known_verdicts':referenceKnown?'runtime_unavailable':runtimeKnown?'newly_resolved_vs_provisional':'both_unresolved';
   rows.push({conversation_id:task.conversation_id,channel:r.conversation.channel,language:r.conversation.language,criterion_id:criterion.id,kind,
    human_holdout:split.holdout10.includes(task.conversation_id),data_chat_value:referenceKnown?a.value:null,runtime_value:runtimeKnown?b.value:null,
    data_chat_explanation:a?.explanation??null,data_chat_review_reason:a?.review_reason??null,runtime_explanation:b?.explanation??r.error??null,
    missing_information:b?.missing_information??[],runtime_evidence:(b?.evidence??[]).map(e=>{const message=r.conversation.transcript.find(m=>m.message_id===e.message_id);return {...e,timestamp:message.timestamp,speaker:message.speaker};})});
  }
 }
}
for(const m of Object.values(metrics)){
 assert.equal(m.total,65);m.agreement_on_both_known=m.runtime_known_on_reference?m.exact_agreements/m.runtime_known_on_reference:null;
 m.agreement_over_reference_known=m.reference_known?m.exact_agreements/m.reference_known:null;
 m.mean_absolute_scale_difference=m.absolute_scale_differences.length?m.absolute_scale_differences.reduce((a,b)=>a+b,0)/m.absolute_scale_differences.length:null;
 delete m.absolute_scale_differences;
}
const rubricChanges=run.checklist.criteria.map(c=>({id:c.id,changed_fields:['type','allowed_values','weight','na_rule','na_channels','instruction','scale'].filter(k=>hash(c[k]??null)!==hash(original.criteria.find(o=>o.id===c.id)?.[k]??null))})).filter(c=>c.changed_fields.length);
const all=Object.values(metrics),known=all.reduce((n,m)=>n+m.reference_known,0),bothKnown=all.reduce((n,m)=>n+m.runtime_known_on_reference,0),matches=all.reduce((n,m)=>n+m.exact_agreements,0);
const rank=r=>(r.kind==='different_known_verdicts'?100:0)+({'08':30,'03':20,'04':15,'02':10,'05':5}[r.criterion_id]??0);
const priority=rows.filter(r=>!r.human_holdout&&r.kind!=='both_unresolved').sort((a,b)=>rank(b)-rank(a));
const report={notice:'AI-to-AI agreement only. data_chat labels are ai_provisional, human_verified=false. Neither side is official GT; differences are review candidates, not proven model errors.',
 run_id:id,baseline_file:baselineFile,baseline_checklist_version:1,runtime_checklist_version:run.checklist.version,rubric_changes:rubricChanges,
 authority:'Original three-page checklist plus accepted organizer clarifications and user policy remain authoritative; do not force agreement with provisional labels.',
 totals:{dialogues:65,criterion_positions:520,reference_known:known,both_known:bothKnown,exact_agreements:matches,agreement_on_both_known:bothKnown?matches/bothKnown:null,
  agreement_over_reference_known:known?matches/known:null,different_known_verdicts:rows.filter(r=>r.kind==='different_known_verdicts').length},
 metrics,priority_review:priority.slice(0,30),all_non_agreements:rows,
 limitations:['Reference v1 and runtime v2 contain documented rubric clarifications; agreement is not a controlled same-rubric accuracy test.',
 'needs_review or missing provisional values are excluded from known-reference denominators. Runtime unknown/failed remain visible and reduce coverage.',
 'The reserved human holdout10 is included in frozen-run summary statistics but excluded from the prompt-adjustment review queue.',
 'No total-score accuracy is reported across differing checklist configurations. No provisional labels or AI verdicts were rewritten.']};
const dir='data/reliability';await mkdir(dir,{recursive:true});await writeFile(join(dir,'data-chat-agreement.json'),JSON.stringify(report,null,2));
const pct=n=>n===null?'—':(n*100).toFixed(1)+'%';
const lines=['Freax — сравнение с предварительной разметкой data_chat',report.notice,
 `Прогон ${id}. Разметка v1, рабочий чек-лист v${run.checklist.version}. Различия инструкций: ${JSON.stringify(rubricChanges)}.`,
 'Критерий | совпадения / обе оценки известны | доля совпадений | известных меток data_chat | неопределённых у runtime | сбоев',
 ...all.map(m=>`${m.id} ${m.name} | ${m.exact_agreements}/${m.runtime_known_on_reference} | ${pct(m.agreement_on_both_known)} | ${m.reference_known} | ${m.runtime_unresolved} | ${m.runtime_failed}`),
 '',`Всего совпадений: ${matches}/${bothKnown} среди известных с обеих сторон; ${known} известных предварительных меток. Это не экспертная точность.`,
 '', 'Первые случаи для разбора (без human holdout10):',...priority.slice(0,15).map(r=>`${r.conversation_id}, ${r.criterion_id}: data_chat=${r.data_chat_value}, runtime=${r.runtime_value}, ${r.kind}. ${r.runtime_explanation}`),
 '',...report.limitations,'Полные источники и объяснения обеих сторон — data-chat-agreement.json.'];
await writeFile(join(dir,'data-chat-agreement.txt'),lines.join('\n')+'\n');
console.log(JSON.stringify({notice:report.notice,totals:report.totals,metrics:all.map(({matrix,...m})=>m),priority_count:priority.length}));
