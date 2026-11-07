import { isDeepStrictEqual } from 'node:util';
import { hash, importConversations, validateChecklist, validateReview, reviewStatus, nonempty, InputError } from './domain.js';
import { calculate } from './scoring.js';
import {legacyExecutionKey} from './execution.js';

// Appendix Results, JSON 1.0. These are submission codes, not internal IDs.
export const SUBMISSION_CRITERIA = Object.freeze([
  { id:'01', code:'contact', type:'boolean', values:[true,false], weight:10 },
  { id:'02', code:'discovery', type:'boolean', values:[true,false,null], weight:15 },
  { id:'03', code:'identification', type:'boolean', values:[true,false,null], weight:20 },
  { id:'04', code:'consultation', type:'scale', values:[0,5,10,15,20,null], weight:20 },
  { id:'05', code:'empathy', type:'boolean', values:[true,false], weight:15 },
  { id:'06', code:'dialogue', type:'scale', values:[0,4,7,10], weight:15 },
  { id:'07', code:'closure', type:'boolean', values:[true,false,null], weight:5 },
  { id:'08', code:'critical', type:'flag', values:[true,false], weight:0 }
].map(c=>Object.freeze({...c,values:Object.freeze(c.values)})));
const byCode=new Map(SUBMISSION_CRITERIA.map(c=>[c.code,c]));
const VIEWS=['original','reviewed-final'];

export class SubmissionError extends Error {
  constructor(code,message,details={}) { super(message);this.name='SubmissionError';this.code=code;this.details=details; }
}
const check=(condition,code,message,details)=>{if(!condition)throw new SubmissionError(code,message,details);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exactKeys=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const projection=c=>({conversation_id:c.conversation_id,language:c.language,channel:c.channel,
  transcript:c.transcript.map(({message_id,timestamp,speaker,text})=>({message_id,timestamp,speaker,text}))});
const safeText=value=>String(value??'').replace(/sk-[A-Za-z0-9_-]{20,}/g,'[REDACTED]')
  .replace(/https?:\/\/[^\s"<>]*[?&](?:sig|signature|token|key)=[^\s"<>]*/gi,'[SIGNED_URL_REDACTED]');

export function submissionDataset(input,subset) {
  check(['dev','prod'].includes(subset),'INVALID_SUBSET','Набор должен быть dev или prod.');
  const conversations=importConversations(input),expected=subset==='dev'?65:10;
  check(conversations.length===expected,'DATASET_COUNT',`${subset.toUpperCase()}: нужно ровно ${expected} исходных диалогов.`,{expected_count:expected,source_count:conversations.length});
  const ids=conversations.map(c=>c.conversation_id);
  check(new Set(ids).size===ids.length,'DUPLICATE_SOURCE_ID','В исходном наборе повторяется conversation_id.');
  const chats=conversations.filter(c=>c.channel==='agent chat').length;
  check(subset==='dev'?chats===60:chats===10,'DATASET_CHANNELS',subset==='dev'?'DEV должен содержать 60 чатов и 5 звонков.':'PROD должен содержать только 10 чатов.');
  return conversations;
}

function compatibleChecklist(checklist) {
  validateChecklist(checklist);
  check(checklist.criteria.length===8&&SUBMISSION_CRITERIA.every(c=>checklist.criteria.some(x=>x.id===c.id)),
    'INCOMPATIBLE_CHECKLIST','Формат сдачи 1.0 требует исходные восемь кодов критериев; другой набор нужно согласовать с организаторами.');
  for(const spec of SUBMISSION_CRITERIA){
    const c=checklist.criteria.find(c=>c.id===spec.id);
    check(c.type===spec.type,'INCOMPATIBLE_CHECKLIST',`Изменён тип критерия ${spec.code}; экспорт без согласованного соответствия невозможен.`);
    if(spec.type==='scale'){
      const values=c.scale.map(s=>s.value).sort((a,b)=>a-b),expected=spec.values.filter(v=>typeof v==='number');
      check(isDeepStrictEqual(values,expected),'INCOMPATIBLE_CHECKLIST',`Шкала ${spec.code} не соответствует формату сдачи 1.0.`);
    }
  }
  return checklist;
}

function standardChecklist() {
  return {schema_version:'1.0',checklist_id:'submission-format-1',name:'Математика приложения JSON 1.0',version:1,
    rounding:'ROUND_HALF_UP',instructions:'Веса и шкалы из приложения к гайду; только проверка арифметики.',
    criteria:SUBMISSION_CRITERIA.map(c=>({id:c.id,name:c.code,section:'',type:c.type,weight:c.weight,
      allow_na:c.values.includes(null),na_rule:c.values.includes(null)?'Условие N/A определяется действующим чек-листом.':'',
      instruction:'Проверка формата, не инструкция оценщику.',
      scale:c.type==='scale'?c.values.filter(v=>typeof v==='number').map(value=>({value,description:String(value)})):[],
      allowed_values:c.values.map(v=>v===true?'yes':v===false?'no':v===null?'na':v)}))};
}

function selectedView(record,view) {
  const original=view==='original',review=record[original?'ai_review':'final_review'];
  const explicit=record[original?'ai_status':'final_status'];
  const status=explicit??(record.status==='failed'||record.status==='running'?record.status:review?reviewStatus(review):record.status);
  return {review,status,score:record[original?'original_score':'final_score']};
}

function selectRecords(evaluations,conversations,{checklistId,checklistVersion,latest,runId}) {
  check(Array.isArray(evaluations),'INVALID_EVALUATIONS','Нужен массив полных Evaluation.');
  const ids=new Set(conversations.map(c=>c.conversation_id));
  if(runId)check(/^[0-9a-f-]{36}$/.test(runId),'INVALID_RUN','Некорректный ID пакетного прогона.');
  if(latest&&!runId)check(nonempty(checklistId)&&Number.isInteger(checklistVersion)&&checklistVersion>0,
    'VERSION_REQUIRED','Для выбора последних запусков явно укажите ID и версию чек-листа.');
  const selected=new Map();let ignored=0;
  for(const r of evaluations){
    if(runId&&r?.run_id!==runId){ignored++;continue;}
    check(object(r)&&object(r.conversation)&&object(r.checklist)&&nonempty(r.conversation.conversation_id)&&Object.hasOwn(r,'ai_review'),
      'INVALID_EVALUATION','Ожидаются полные сохранённые Evaluation, а не сводная история, разметка или результаты другого формата.');
    const id=r.conversation.conversation_id;
    if((checklistId&&r.checklist?.checklist_id!==checklistId)||(checklistVersion!==undefined&&r.checklist?.version!==checklistVersion)) {ignored++;continue;}
    if(!ids.has(id)){
      if(latest){ignored++;continue;}
      throw new SubmissionError('UNEXPECTED_ID','В оценках есть ID, отсутствующий в выбранном исходном наборе.',{unexpected_ids:[id]});
    }
    const previous=selected.get(id);
    if(previous){
      check(latest,'DUPLICATE_EVALUATION_ID','Для одного диалога передано несколько оценок; выберите один запуск или явно включите --latest.',{duplicate_ids:[id]});
      const a=Date.parse(previous.created_at),b=Date.parse(r.created_at);
      check(Number.isFinite(a)&&Number.isFinite(b)&&a!==b,'AMBIGUOUS_LATEST','Нельзя однозначно выбрать последний запуск; передайте конкретные Evaluation.',{duplicate_ids:[id]});
      // Latest attempt wins even if it failed or is partial. Never prefer a good old score.
      if(b<a){ignored++;continue;}
      ignored++;
    }
    selected.set(id,r);
  }
  const missing=conversations.filter(c=>!selected.has(c.conversation_id)).map(c=>c.conversation_id);
  check(!missing.length,'MISSING_EVALUATIONS','Набор оценён не полностью. Файл сдачи не создан и не перезаписан.',
    {expected_count:conversations.length,available_count:selected.size,missing_count:missing.length,missing_ids:missing,ignored_evaluations:ignored});
  const ordered=conversations.map(c=>selected.get(c.conversation_id));
  const snapshots=new Set(ordered.map(r=>hash(r.checklist)));
  check(snapshots.size===1,'MIXED_CHECKLISTS','Нельзя смешивать разные версии или снимки чек-листа в одной выгрузке.');
  check(new Set(ordered.map(r=>r.run_id??null)).size===1,'MIXED_RUNS','Нельзя смешивать разные пакетные прогоны или прогон с отдельными оценками. Выберите --run-id.');
  for(const r of ordered)if(r.execution_snapshot)check(r.configuration_hash===hash(r.execution_snapshot),'EXECUTION_HASH','Нарушена целостность настроек оценки.');
  check(new Set(ordered.map(legacyExecutionKey)).size===1,'MIXED_EXECUTIONS','Нельзя смешивать версии промпта, модели, схемы или справки в одном файле. Выберите единый прогон.');
  compatibleChecklist(ordered[0].checklist);
  return {records:ordered,ignored};
}

function actualModels(records) {
  const names=new Set(),modes=new Set();
  for(const r of records){
    const metadata=r.ai_metadata??{};
    const calls=Array.isArray(metadata.calls)&&metadata.calls.length?metadata.calls:[metadata];
    for(const call of calls){
      const name=call.returned_model||call.model||call.requested_model||metadata.returned_model||metadata.model||metadata.requested_model;
      const provider=call.provider||metadata.provider;
      check(nonempty(name)&&!/[\r\n]/.test(name)&&safeText(name)===name,'MISSING_MODEL','Не удалось установить фактическую модель из метаданных запуска.');
      const mode=({cloud:'external_api',external_api:'external_api',local:'local',hybrid:'hybrid'})[provider];
      check(mode,'MISSING_MODEL_MODE','Не удалось установить режим модели: local, external_api или hybrid.');
      names.add(name);modes.add(mode);
    }
  }
  return {mode:modes.size===1?[...modes][0]:'hybrid',name:[...names].sort().join(', ')};
}

function errorResult(id,reason) {
  return {conversation_id:id,status:'error',criteria:[],score:null,error:safeText(reason).slice(0,4000)};
}

function exportResult(record,conversation,view) {
  const {review,status,score}=selectedView(record,view),id=conversation.conversation_id;
  check(status!=='running','RUNNING_EVALUATION','Есть незавершённая оценка; дождитесь результата перед выгрузкой.',{conversation_id:id});
  if(status==='failed')return errorResult(id,record.error||'Оценка не завершена: модель или проверка ответа вернули ошибку.');
  try {
    check(['completed','partial'].includes(status),'INVALID_STATUS','Нет завершённой исходной оценки выбранного представления.');
    check(isDeepStrictEqual(projection(record.conversation),projection(conversation)),
      'TRANSCRIPT_MISMATCH','Сохранённый транскрипт не совпадает с исходным набором для этого ID.');
    if(record.checklist_hash)check(record.checklist_hash===hash(record.checklist),'CHECKLIST_HASH','Нарушена целостность снимка чек-листа.');
    validateReview(review,record.checklist,conversation);
    const unresolved=review.criteria.filter(c=>c.status==='unresolved');
    if(unresolved.length){
      const reason=unresolved.map(c=>`${SUBMISSION_CRITERIA.find(s=>s.id===c.criterion_id).code}: ${c.missing_information.join('; ')}`).join(' | ');
      return errorResult(id,`Частичная оценка: ${reason}. В формате сдачи null означает только N/A; неопределённость не преобразована в N/A или ноль.`);
    }
    const recalculated=calculate(record.checklist,review,conversation.channel);
    check(score&&score.total===recalculated.total&&score.gross_error===recalculated.gross_error,
      'SCORE_MISMATCH','Сохранённый итог или флаг не совпадает с расчётом по сохранённым ответам.');
    check(typeof score.total==='number'&&Number.isFinite(score.total),'NULL_TOTAL','Полный числовой итог отсутствует; формат ok требует итог от 0 до 100.');
    const position=new Map(conversation.transcript.map((m,i)=>[m.message_id,i+1]));
    const rows=new Map(review.criteria.map(c=>[c.criterion_id,c]));
    const criteria=SUBMISSION_CRITERIA.map(spec=>{
      const row=rows.get(spec.id),value=row.value==='yes'?true:row.value==='no'?false:row.value==='na'?null:row.value;
      check(spec.values.includes(value),'UNSUPPORTED_VALUE',`Значение ${spec.code} не представимо в формате сдачи 1.0. В частности, contact не допускает null.`);
      const turns=new Set(row.evidence.map(e=>position.get(e.message_id)));
      for(const range of row.checked_ranges){
        for(let i=position.get(range.from_message_id);i<=position.get(range.to_message_id);i++)turns.add(i);
      }
      let rationale=row.explanation.trim();
      if(value===null&&!rationale.includes(row.na_reason.trim()))rationale+=` N/A: ${row.na_reason.trim()}`;
      return {criterion_id:spec.code,value,rationale,evidence_turns:[...turns].sort((a,b)=>a-b)};
    });
    return {conversation_id:id,status:'ok',criteria,score:{final_score:score.total,critical_flag:score.gross_error}};
  } catch(error) {
    if(error instanceof InputError||error instanceof SubmissionError)return errorResult(id,error.message);
    throw error;
  }
}

/** Export original machine reviews by default; reviewed-final is always explicit. */
export function buildSubmission({teamName='Freax',dataset,subset,evaluations,view='original',checklistId,checklistVersion,latest=false,runId}) {
  check(nonempty(teamName)&&teamName.trim()!=='Название команды','INVALID_TEAM','Нужно настоящее название команды.');
  check(VIEWS.includes(view),'INVALID_VIEW','Представление должно быть original или reviewed-final.');
  const conversations=submissionDataset(dataset,subset);
  const {records,ignored}=selectRecords(evaluations,conversations,{checklistId,checklistVersion,latest:latest||Boolean(runId),runId});
  const document={schema_version:'1.0',team_name:teamName.trim(),model:actualModels(records),
    results:records.map((r,i)=>exportResult(r,conversations[i],view))};
  validateSubmission(document,{dataset:conversations,subset,checklist:records[0].checklist});
  const ok=document.results.filter(r=>r.status==='ok').length;
  const report={format_valid:true,subset,source_view:view,expected_count:conversations.length,ok_count:ok,
    error_count:conversations.length-ok,all_scored:ok===conversations.length,ignored_evaluations:ignored,
    checklist_id:records[0].checklist.checklist_id,checklist_version:records[0].checklist.version,
    checklist_hash:hash(records[0].checklist),dataset_hash:hash(conversations.map(projection)),run_id:records[0].run_id??null,configuration_hash:legacyExecutionKey(records[0]),
    selected_evaluations:records.map(r=>({conversation_id:r.conversation.conversation_id,evaluation_id:r.evaluation_id??null})),
    errors:document.results.filter(r=>r.status==='error').map(r=>({conversation_id:r.conversation_id,error:r.error}))};
  return {document,report,checklist:structuredClone(records[0].checklist)};
}

/** Validate the public file against the original corpus, not just its JSON syntax. */
export function validateSubmission(document,{dataset,subset,checklist}={}) {
  const conversations=submissionDataset(dataset,subset),sources=new Map(conversations.map(c=>[c.conversation_id,c]));
  check(exactKeys(document,['schema_version','team_name','model','results'])&&document.schema_version==='1.0',
    'INVALID_DOCUMENT','Нужен объект JSON 1.0 с полями schema_version, team_name, model, results.');
  check(nonempty(document.team_name)&&document.team_name!=='Название команды','INVALID_TEAM','Не заполнено название команды.');
  check(exactKeys(document.model,['mode','name'])&&['local','external_api','hybrid'].includes(document.model.mode)&&nonempty(document.model.name),
    'INVALID_MODEL','model должен содержать mode (local/external_api/hybrid) и фактическое name.');
  check(Array.isArray(document.results)&&document.results.length===conversations.length,'RESULT_COUNT','Количество результатов не совпадает с полным исходным набором.');
  const ids=new Set(),mathChecklist=checklist?compatibleChecklist(checklist):standardChecklist();
  for(const result of document.results){
    check(object(result)&&sources.has(result.conversation_id),'UNEXPECTED_ID','ID результата отсутствует в исходном наборе.');
    check(!ids.has(result.conversation_id),'DUPLICATE_ID','Повторный conversation_id в results.');ids.add(result.conversation_id);
    if(result.status==='error'){
      check(exactKeys(result,['conversation_id','status','criteria','score','error'])&&Array.isArray(result.criteria)&&result.criteria.length===0&&result.score===null&&nonempty(result.error),
        'INVALID_ERROR','Для error обязательны criteria: [], score: null и непустая причина error.');
      continue;
    }
    check(result.status==='ok'&&exactKeys(result,['conversation_id','status','criteria','score']),
      'INVALID_RESULT','Допустимы только status ok/error и соответствующие поля.');
    check(Array.isArray(result.criteria)&&result.criteria.length===8,'CRITERION_COUNT','Для ok нужны восемь критериев ровно по одному.');
    const seen=new Set(),internal=[];
    for(const criterion of result.criteria){
      const spec=byCode.get(criterion?.criterion_id);
      check(exactKeys(criterion,['criterion_id','value','rationale','evidence_turns'])&&spec&&!seen.has(spec.code),
        'INVALID_CRITERION','Неизвестный/повторный код или поля критерия.');seen.add(spec.code);
      check(spec.values.includes(criterion.value),'INVALID_VALUE',`Недопустимое значение ${spec.code}. null означает только разрешённый N/A.`);
      check(nonempty(criterion.rationale),'EMPTY_RATIONALE','Нет rationale критерия.');
      const turns=criterion.evidence_turns,length=sources.get(result.conversation_id).transcript.length;
      check(Array.isArray(turns)&&turns.length>0&&turns.every(n=>Number.isInteger(n)&&n>=1&&n<=length)&&new Set(turns).size===turns.length,
        'INVALID_TURNS','evidence_turns должны ссылаться с 1 на исходный массив, включая клиента, бота и события.');
      internal.push({criterion_id:spec.id,value:criterion.value===true?'yes':criterion.value===false?'no':criterion.value===null?'na':criterion.value});
    }
    check(exactKeys(result.score,['final_score','critical_flag'])&&typeof result.score.final_score==='number'&&Number.isFinite(result.score.final_score)&&result.score.final_score>=0&&result.score.final_score<=100&&Math.abs(result.score.final_score*100-Math.round(result.score.final_score*100))<1e-8,
      'INVALID_SCORE','final_score должен быть числом 0–100 с округлением до двух знаков.');
    const critical=result.criteria.find(c=>c.criterion_id==='critical').value;
    check(result.score.critical_flag===critical,'FLAG_MISMATCH','critical_flag должен совпадать с value критерия critical.');
    // Optional snapshot preserves changed weights without silently reverting to PDF defaults.
    const computed=calculate(mathChecklist,{criteria:internal},sources.get(result.conversation_id).channel);
    check(computed.total===result.score.final_score,'ARITHMETIC_MISMATCH','Итог не соответствует ответам и выбранным весам; для изменённых весов передайте снимок чек-листа.');
  }
  check(ids.size===sources.size,'MISSING_ID','В результатах пропущены исходные ID.');
  return {valid:true,records:ids.size,ok_count:document.results.filter(r=>r.status==='ok').length,error_count:document.results.filter(r=>r.status==='error').length};
}

// This schema validates submission files; it is NOT an OpenAI response schema.
export function submissionSchema() {
  const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
  const criterion=spec=>obj({criterion_id:{const:spec.code},value:{enum:spec.values},rationale:{type:'string',minLength:1},
    evidence_turns:{type:'array',minItems:1,uniqueItems:true,items:{type:'integer',minimum:1}}});
  const ok=obj({conversation_id:{type:'string',minLength:1},status:{const:'ok'},criteria:{type:'array',minItems:8,maxItems:8,
    items:{oneOf:SUBMISSION_CRITERIA.map(criterion)},allOf:SUBMISSION_CRITERIA.map(c=>({contains:{type:'object',properties:{criterion_id:{const:c.code}},required:['criterion_id']},minContains:1,maxContains:1}))},
    score:obj({final_score:{type:'number',minimum:0,maximum:100,multipleOf:0.01},critical_flag:{type:'boolean'}})});
  const error=obj({conversation_id:{type:'string',minLength:1},status:{const:'error'},criteria:{type:'array',maxItems:0},score:{type:'null'},error:{type:'string',minLength:1}});
  return {$schema:'https://json-schema.org/draft/2020-12/schema',title:'CQA submission JSON 1.0',
    $comment:'Appendix Results. Dataset coverage, source turn bounds, flag equality and exact arithmetic also require src/submission.js.',
    ...obj({schema_version:{const:'1.0'},team_name:{type:'string',minLength:1},model:obj({mode:{enum:['local','external_api','hybrid']},name:{type:'string',minLength:1}}),results:{type:'array',minItems:1,items:{oneOf:[ok,error]}}})};
}
