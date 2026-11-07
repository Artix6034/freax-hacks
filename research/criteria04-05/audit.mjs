import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {hash,validateReview} from '../../src/domain.js';
import {validateDialogFacts} from '../../src/ai/facts.js';
import {cleanUsage} from '../../src/ai/transport.js';
import {calculate} from '../../src/scoring.js';

const root=resolve('data/criteria04-05'),read=async p=>JSON.parse(await readFile(p,'utf8'));
const stages=['baseline','candidate','holdout'],runs=[];
let quotes=0,ranges=0,promptTokens=0,completionTokens=0,missingUsage=0;
for(const stage of stages){
 const d=join(root,stage);let report;
 try{report=await read(join(d,'report.json'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
 assert.ok(report.completed_at,`${stage} not finished`);assert.equal(report.model_calls,report.planned_calls);
 const prepared=await read(join(d,'prepared.json')),raws=[],rawDiagnostics=[];
 assert.equal(hash(await readFile(join(d,'system-prompt.txt'),'utf8')),report.prompt_hash);
 for(let n=1;n<=report.model_calls;n++){
  const request=await read(join(d,'transport',`${n}-request.json`)),response=await read(join(d,'transport',`${n}-response.json`));
  assert.equal(hash(request.messages[0].content),report.prompt_hash);
  const payload=JSON.parse(request.messages[1].content),source=prepared.find(p=>p.conversation.conversation_id===payload.conversation.conversation_id);
  assert.ok(source);assert.deepEqual(Object.keys(payload),['checklist','conversation','verified_reference']);assert.deepEqual(request.messages,source.messages);
  assert.deepEqual(request.response_format.json_schema.schema,source.schema);
  let parsed;try{parsed=JSON.parse(response.choices[0].message.content);}catch{}
  const usage=cleanUsage(response.usage);rawDiagnostics.push({conversation_id:payload.conversation.conversation_id,usage_hash:hash(usage),raw_values:parsed?.evaluations?.criteria_by_id??null});
  if(parsed?.evaluations?.criteria_by_id)raws.push(hash({review:{criteria:payload.checklist.criteria.map(c=>parsed.evaluations.criteria_by_id[c.id])},facts:parsed.dialog_facts,usage}));
 }
 const records=[];
 for(const file of (await readdir(d)).filter(f=>/^[0-9a-f-]{36}\.json$/.test(f))){
  const r=await read(join(d,file));records.push(r);assert.equal(r.ai_metadata.attempts,1);assert.equal(r.prompt_version,report.prompt_version);assert.equal(r.ai_metadata.prompt_hash,report.prompt_hash);
  const source=prepared.find(p=>p.conversation.conversation_id===r.conversation.conversation_id);assert.deepEqual(r.conversation,source.conversation);
  if(r.ai_review){
   validateReview(r.ai_review,r.checklist,r.conversation);validateDialogFacts(r.ai_facts,r.conversation);
   assert.deepEqual(r.original_score,calculate(r.checklist,r.ai_review,r.conversation.channel));
   const key=hash({review:r.ai_review,facts:r.ai_facts,usage:r.ai_metadata.usage}),index=raws.indexOf(key);assert.ok(index>=0);raws.splice(index,1);
   quotes+=r.ai_review.criteria.reduce((n,c)=>n+c.evidence.length,0);ranges+=r.ai_review.criteria.reduce((n,c)=>n+c.checked_ranges.length,0);
  }
  const usage=r.ai_metadata.usage;if(usage){promptTokens+=usage.prompt_tokens??0;completionTokens+=usage.completion_tokens??0;}else missingUsage++;
 }
 assert.equal(records.length,report.planned_calls);assert.equal(report.attempts.length,records.length);
 const details=report.attempts.map(a=>{
  const record=records.find(r=>r.evaluation_id===a.evaluation_id);assert.ok(record);
  const source=prepared.find(p=>p.case_id===a.case_id);assert.ok(source);
  if(source.expected_status==='unresolved'&&record.ai_review&&a.target_status==='match'){
   assert.equal(record.status,'partial');assert.equal(record.original_score.total,null);
   assert.ok(record.ai_review.criteria.some(c=>c.criterion_id!==source.criterion_id&&c.status==='resolved'),'Other usable criteria were lost');
  }
  const raw=record.status==='failed'?rawDiagnostics.find(d=>d.conversation_id===record.conversation.conversation_id&&d.usage_hash===hash(record.ai_metadata.usage)):null;
  return {...a,total:record.original_score?.total??null,unresolved_criteria:record.ai_review?.criteria.filter(c=>c.status==='unresolved').map(c=>c.criterion_id)??[],
   rejection_diagnostic:raw?{raw_values:Object.fromEntries(['04','05','06'].map(id=>[id,raw.raw_values?.[id]?.value??null])),notice:'Not accepted; raw scores are not usable assessments.'}:null,
   criteria:a.criteria.map(c=>({...c,evidence:c.evidence.map(e=>{const m=source.conversation.transcript.find(m=>m.message_id===e.message_id);assert.ok(m&&m.text.includes(e.quote));return {...e,timestamp:m.timestamp,speaker:m.speaker};})}))};
 });
 const outcomes=prepared.map(p=>({case_id:p.case_id,kind:p.kind,criterion_id:p.criterion_id,expected:p.expected,expected_status:p.expected_status,
  outcomes:details.filter(a=>a.case_id===p.case_id).sort((a,b)=>a.repeat-b.repeat).map(a=>({repeat:a.repeat,status:a.target_status,
   values:Object.fromEntries(a.criteria.filter(c=>['04','05','06'].includes(c.criterion_id)).map(c=>[c.criterion_id,c.value])),error:a.error}))}));
 const counts={calls:report.model_calls,accepted:records.filter(r=>r.ai_review).length,failed:records.filter(r=>!r.ai_review).length,
  frozen_expected_matches:details.filter(a=>a.target_status==='match').length,frozen_expected_mismatches:details.filter(a=>['mismatch','unresolved'].includes(a.target_status)).length,
  diagnostic_without_frozen_target:details.filter(a=>a.target_status==='diagnostic').length};
 runs.push({stage,version:report.prompt_version,prompt_hash:report.prompt_hash,settings:report.settings,counts,outcomes,details});
}
assert.ok(runs.some(r=>r.stage==='baseline')&&runs.some(r=>r.stage==='holdout'),'Need completed baseline and transfer check');
for(const r of runs)assert.deepEqual(r.settings,runs[0].settings,'Model/settings changed');
const interpretation=await read(new URL('./interpretations.json',import.meta.url));
const userCheck=runs.flatMap(r=>r.details.filter(a=>a.case_id===interpretation.criterion05.diagnostic_expectation.case_id).map(a=>({stage:r.stage,repeat:a.repeat,
 value:a.criteria.find(c=>c.criterion_id==='05')?.value??null,expected:interpretation.criterion05.diagnostic_expectation.value,
 matches:a.criteria.find(c=>c.criterion_id==='05')?.value===interpretation.criterion05.diagnostic_expectation.value,source:interpretation.criterion05.diagnostic_expectation.source})));
const summary={notice:'Synthetic expectations and interpretations are not official GT. Matching values do not establish general accuracy. Human holdout10 untouched.',
 runs:runs.map(({details,...r})=>r),user_interpretation_check:userCheck,interpretations:interpretation,
 verification:{quotes,ranges,prompt_tokens:promptTokens,completion_tokens:completionTokens,missing_usage:missingUsage},
 decision:runs.some(r=>r.stage==='candidate')?'A candidate was tested; inspect paired outcomes before deploying.':'No candidate was introduced. Do not claim a prompt improvement when baseline already met the tested conditions.',
 limitations:['Small assistant-authored development pairs; the author knows the later transfer cases.','Only 05 interpretation is explicitly approved by the user; actual transcript scores are assistant judgments.','KZ fixture language needs native review.','Evidence existence and source role checks do not prove semantic correctness.','No official accuracy measured or production export generated.'],
 details:runs.flatMap(r=>r.details.map(d=>({stage:r.stage,...d})))};
await writeFile(join(root,'comparison.json'),JSON.stringify(summary,null,2));
const lines=['Freax — диагностика критериев 04 и 05',summary.notice,'',...summary.runs.flatMap(r=>[
 `${r.stage}: ${r.version}; ${JSON.stringify(r.counts)}`,
 ...r.outcomes.map(c=>`${c.case_id}: ожидание ${c.expected_status??c.expected??'диагностическое, без эталона'}; ${c.outcomes.map(o=>`${o.status} ${JSON.stringify(o.values)}${o.error?' ERROR '+o.error:''}`).join(' / ')}`),'']),
 '05, трактовка пользователя (без обязательных слов извинения):',...userCheck.map(c=>`${c.stage}, повтор ${c.repeat}: ${c.value}, ожидание ${c.expected}, совпадение ${c.matches}.`),
 '', '04, реальный RU: 20 — прежний вывод ассистента, а не эталон. Текущий результат 10 ссылается на запрошенное, но не полученное название бумаги. Обе трактовки сохранены; случай требует независимого разбора достаточности следующего шага.',
 '', 'Обоснования по реальным чатам:',...runs.flatMap(r=>r.details.filter(d=>['DEV diagnostic','fresh pilot diagnostic'].includes(d.kind)).flatMap(d=>[
  `${r.stage}: ${d.case_id}`,...d.criteria.filter(c=>['04','05'].includes(c.criterion_id)).map(c=>`${c.criterion_id}=${c.value}: ${c.explanation} Основание: ${c.evidence.slice(0,2).map(e=>`${e.message_id} ${e.timestamp} «${e.quote}»`).join('; ')}`)
 ])),
 '',summary.decision,`Проверка источников и usage: ${JSON.stringify(summary.verification)}`,...summary.limitations,
 'comparison.json содержит все обоснования, IDs, timestamps, цитаты, диапазоны, неизвестные факты и ошибки. Исходная рабочая история не изменялась.'];
await writeFile(join(root,'report.txt'),lines.join('\n')+'\n');
console.log(JSON.stringify({runs:summary.runs.map(r=>({stage:r.stage,version:r.version,counts:r.counts})),userCheck,verification:summary.verification,decision:summary.decision}));
