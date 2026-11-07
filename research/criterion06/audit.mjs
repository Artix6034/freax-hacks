import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {hash,validateReview} from '../../src/domain.js';
import {validateDialogFacts} from '../../src/ai/facts.js';
import {cleanUsage} from '../../src/ai/transport.js';
import {calculate} from '../../src/scoring.js';
const root=resolve('data/criterion06-pairs');
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const reports=[],all=[],rawDiagnostics=[];let quotes=0,ranges=0,unknownUsage=0,cost=0;
for(const name of ['baseline','baseline-actual','candidate']){
 const d=join(root,name),report=await read(join(d,'report.json')),prepared=await read(join(d,'prepared.json'));
 assert.ok(report.completed_at,'Experiment is incomplete');assert.equal(report.model_calls,report.planned_calls);
 const raws=[];
 for(let n=1;n<=report.model_calls;n++){
  const response=await read(join(d,'transport',`${n}-response.json`));
  const request=await read(join(d,'transport',`${n}-request.json`));
  assert.equal(hash(request.messages[0].content),report.prompt_hash);
  const user=JSON.parse(request.messages[1].content);assert.deepEqual(Object.keys(user),['checklist','conversation','verified_reference']);
  const original=prepared.find(c=>c.conversation.conversation_id===user.conversation.conversation_id);assert.ok(original);assert.deepEqual(request.messages,original.messages);
  let parsed;try{parsed=JSON.parse(response.choices[0].message.content);}catch{}
  rawDiagnostics.push({stage:name,conversation_id:user.conversation.conversation_id,usage_hash:hash(cleanUsage(response.usage)),
   raw_value06:parsed?.evaluations?.criteria_by_id?.['06']?.value??null,response_file:join(d,'transport',`${n}-response.json`)});
  if(parsed?.evaluations?.criteria_by_id)raws.push(hash({review:{criteria:user.checklist.criteria.map(c=>parsed.evaluations.criteria_by_id[c.id])},facts:parsed.dialog_facts,usage:cleanUsage(response.usage)}));
 }
 for(const file of (await readdir(d)).filter(f=>/^[0-9a-f-]{36}\.json$/.test(f))){
  const r=await read(join(d,file));all.push({stage:name,record:r});
  assert.equal(r.ai_metadata.attempts,1);assert.equal(r.prompt_version,report.prompt_version);assert.equal(r.ai_metadata.prompt_hash,report.prompt_hash);
  const source=prepared.find(c=>c.conversation.conversation_id===r.conversation.conversation_id);assert.deepEqual(source.conversation,r.conversation);
  if(r.ai_review){
   validateReview(r.ai_review,r.checklist,r.conversation);validateDialogFacts(r.ai_facts,r.conversation);
   assert.deepEqual(r.original_score,calculate(r.checklist,r.ai_review,r.conversation.channel));
   const key=hash({review:r.ai_review,facts:r.ai_facts,usage:r.ai_metadata.usage}),index=raws.indexOf(key);assert.ok(index>=0,'Saved review differs from raw response');raws.splice(index,1);
   quotes+=r.ai_review.criteria.reduce((n,c)=>n+c.evidence.length,0);ranges+=r.ai_review.criteria.reduce((n,c)=>n+c.checked_ranges.length,0);
  }
  const u=r.ai_metadata.usage;
  if(!u){unknownUsage++;continue;}
  const cached=u.prompt_tokens_details?.cached_tokens??0,written=u.prompt_tokens_details?.cache_write_tokens??0;
  assert.ok(u.prompt_tokens>=cached+written);
  cost+=((u.prompt_tokens-cached-written)*2+cached*.1+written*2.5+u.completion_tokens*10)/1e6;
 }
 reports.push({name,report,prepared});
}
const baseline=reports[0],actual=reports[1],candidate=reports[2];
assert.equal(all.length,30);assert.equal(baseline.report.suite_hash,candidate.report.suite_hash);assert.equal(actual.report.suite_hash,candidate.report.suite_hash);
assert.equal(baseline.report.checklist_hash,candidate.report.checklist_hash);assert.deepEqual(baseline.report.settings,candidate.report.settings);
const oldPrompt=await readFile(join(root,'baseline/system-prompt.txt'),'utf8'),newPrompt=await readFile(join(root,'candidate/system-prompt.txt'),'utf8');
const a=newPrompt.indexOf('Where the CURRENT dialogue scale'),b=newPrompt.indexOf('Evidence rules apply to BOTH sections.',a);assert.ok(a>=0&&b>a);
assert.equal(newPrompt.slice(0,a)+newPrompt.slice(b),oldPrompt,'More than the minimal paragraph changed');
for(const p of baseline.prepared){const newer=candidate.prepared.find(c=>c.case_id===p.case_id);assert.deepEqual(p.conversation,newer.conversation);assert.deepEqual(p.messages[1],newer.messages[1]);assert.deepEqual(p.schema,newer.schema);}
const row=(r,id)=>r.summary.find(c=>c.case_id===id)?.outcomes??[];
const display=values=>values.map(v=>v===null?'отклонён':String(v)).join('/');
const pairs=baseline.report.summary.map(c=>({case_id:c.case_id,expected:c.expected,before:c.outcomes,after:row(candidate.report,c.case_id)}));
const beforeReal=row(actual.report,'actual-kz-008'),afterReal=row(candidate.report,'actual-kz-008');
const accepted=all.filter(x=>x.record.ai_review).length;
const failedDiagnostics=all.filter(x=>!x.record.ai_review).map(({stage,record:r})=>({stage,evaluation_id:r.evaluation_id,error:r.error,
 raw_value06:rawDiagnostics.find(d=>d.stage===stage&&d.conversation_id===r.conversation.conversation_id&&d.usage_hash===hash(r.ai_metadata.usage))?.raw_value06??null,
 accepted:false,notice:'Raw verdict is diagnostic only. The whole response failed validation and is not a usable assessment.'}));
for(const a of candidate.report.attempts){if(a.expected02!==null&&a.target_status!=='failed')assert.equal(a.value02,a.expected02,'Criterion 02 control regressed');}
const summary={notice:'Same frozen paired inputs and settings, changed system prompt only. Development expectations are not official or human GT. Two repetitions do not establish general stability.',
 sources:{checklist:'CQA_Chat_Quality_Checklist 1.pdf',pages:[2,3]},
 versions:{before:baseline.report.prompt_version,after:candidate.report.prompt_version},pairs,
 actual_KZ:{before:beforeReal,after:afterReal,details:candidate.report.attempts.filter(a=>a.case_id==='actual-kz-008').map(a=>{
  const r=all.find(x=>x.record.evaluation_id===a.evaluation_id).record;return {evaluation_id:r.evaluation_id,value06:a.value06,value02:a.value02,total:r.original_score?.total??null,
   explanation06:a.explanation06,all_values:r.ai_review?.criteria.map(c=>({id:c.criterion_id,value:c.value}))??[]};})},
 controls:candidate.report.summary.filter(c=>c.kind==='control'),failed_diagnostics:failedDiagnostics,
 counts:{calls:30,accepted,failed:all.length-accepted,baseline_pair_matches:baseline.report.attempts.filter(a=>a.target_status==='match').length,
  candidate_pair_matches:candidate.report.attempts.filter(a=>a.kind==='paired'&&a.target_status==='match').length,
  candidate_other_matches:candidate.report.attempts.filter(a=>a.kind!=='paired'&&a.target_status==='match').length,
  quotes_verified:quotes,ranges_verified:ranges},
 review_notes:candidate.report.attempts.map(a=>({case_id:a.case_id,repeat:a.repeat,expected:a.expected,value06:a.value06,explanation:a.explanation06,
  source_ids:[...new Set(a.evidence06.map(e=>e.message_id))],ranges:a.ranges06})),
 estimated_standard_usd:unknownUsage?null:cost,known_usage_estimated_usd:cost,unknown_usage_calls:unknownUsage,pricing_source:'https://developers.openai.com/api/docs/pricing',
 pricing_assumption:'Standard short context, USD/M: input 2, cached .1, default 30m cache write 2.5, output 10. Estimate from usage, not an invoice.',
 activation:'Source prompt updated; previously started web service requires a restart. Old scores were not rewritten.',
 limitations:['Only three closely related synthetic pairs and one familiar DEV chat.','Expected values are assistant interpretations of the PDF, not independent expert labels.','KZ fixture language needs native review.','Pair success alone did not reveal the original real-chat instability.','Citation existence does not prove every interpretation correct.']};
await writeFile(join(root,'comparison.json'),JSON.stringify(summary,null,2));
const lines=['Freax — парная проверка критерия 06',`${summary.versions.before} → ${summary.versions.after}`,
 'Основание: PDF, страница 2 — ступени 7 и 4; страница 3 — разделение консультации и ведения диалога.',
 'В каждой паре меняются только одна реплика оператора и реакция клиента; прочие сообщения, шкала, веса, модель и настройки сохранены.',
 '',...pairs.map(c=>`${c.case_id}: ожидание ${c.expected}; до ${c.before.join('/')}; после ${c.after.join('/')}.`),
 `Реальный p1-kz-008: до ${display(beforeReal)}; после ${display(afterReal)}.`,
 ...summary.actual_KZ.details.filter(c=>c.value06!==null).map(c=>`Новая запись ${c.evaluation_id}: 02=${c.value02}, 06=${c.value06}, итог ${c.total}. ${c.explanation06}`),
 ...summary.controls.map(c=>`Контроль ${c.case_id}: ожидание ${c.expected}; результат ${c.outcomes.join('/')}.`),
 ...failedDiagnostics.map(d=>`Отклонённая запись ${d.evaluation_id}: ${d.error} Сырой вердикт 06=${d.raw_value06}, но результат НЕ принят.`),
 '',`Проверка источников: ${JSON.stringify(summary.counts)}.`,
 `Оценка стоимости по Standard usage: ${unknownUsage?'неполная; известная часть ':''}$${cost.toFixed(6)}; вызовов без usage: ${unknownUsage}. Источник: https://developers.openai.com/api/docs/pricing .`,
 'Поправка уточняет применение действующей формулировки; новые шкалы, пороги ожидания, ограничения 04 и обязательные слова сочувствия не вводились.',
 'Частичные результаты, N/A, динамические критерии и один вызов на диалог сохранены.',
 '',...summary.limitations,summary.activation,
 'Подробности: comparison.json, исходные файлы экспериментов — baseline/, baseline-actual/, candidate/.'
];await writeFile(join(root,'report.txt'),lines.join('\n')+'\n');
console.log(JSON.stringify({versions:summary.versions,counts:summary.counts,pairs,actual_KZ:summary.actual_KZ,controls:summary.controls,estimated_standard_usd:summary.estimated_standard_usd}));
