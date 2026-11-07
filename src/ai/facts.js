import { requireThat, nonempty } from '../domain.js';

const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str={type:'string',minLength:1};
const strings={type:'array',items:str};
const evidence={type:'array',items:{$ref:'#/$defs/evidence'}};
const ranges={type:'array',items:{$ref:'#/$defs/range'}};

/** Public, source-linked observations. This is not private chain-of-thought. */
export function buildDialogFactsSchema(sourceRefs = {}) {
  const roleEvidence = role => sourceRefs[role] ? {type:'array',items:{$ref:sourceRefs[role]},...(sourceRefs.emptyRoles?.includes(role)?{maxItems:0}:{})} : evidence;
  return obj({
    client_language:obj({languages:{type:'array',items:{type:'string',enum:['RU','KZ','EN','other']}},
      certainty:{type:'string',enum:['supported','uncertain']},explanation:str,evidence:roleEvidence('client')}),
    first_operator_message_id:sourceRefs.firstOperator === undefined ? {type:['string','null']} : {type:sourceRefs.firstOperator===null?'null':'string',enum:[sourceRefs.firstOperator]},
    client_questions:{type:'array',items:obj({question_id:str,summary:str,evidence:roleEvidence('client'),
      operator_responses:{type:'array',items:obj({summary:str,evidence:roleEvidence('operator')})},
      response_state:{type:'string',enum:['present','not_observed','uncertain']},checked_ranges:ranges,missing_information:strings})},
    context_events:{type:'array',items:obj({kind:{type:'string',enum:['verification_confirmation','handoff','closure','other']},summary:str,evidence:roleEvidence('context')})},
    observations:{type:'array',items:obj({kind:{type:'string',enum:['known_context','complaint','operator_statement','interaction','other']},
      statement:str,basis:{type:'string',enum:['direct_quote','checked_absence','uncertain']},evidence,checked_ranges:ranges,uncertainty_reason:{type:'string'}})},
    limitations:strings
  });
}

const keys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const list=(value,label)=>requireThat(Array.isArray(value),`dialog_facts: нужен массив ${label}.`);
const textList=(value,label)=>{list(value,label);requireThat(value.every(nonempty),`dialog_facts: пустой элемент ${label}.`);};

export function validateDialogFacts(facts,conversation) {
  requireThat(keys(facts,['client_language','first_operator_message_id','client_questions','context_events','observations','limitations']),
    'dialog_facts: неверный или неполный набор полей.');
  const messages=conversation.transcript;
  const byId=new Map(messages.map((m,index)=>[m.message_id,{...m,index}]));
  const quotes=(items,label,roles)=>{
    list(items,label);
    for(const e of items){
      const source=byId.get(e?.message_id);
      requireThat(keys(e,['message_id','quote'])&&source&&nonempty(e.quote)&&source.text.includes(e.quote),`dialog_facts: неизвестная реплика или неточная цитата (${label}).`);
      if(roles)requireThat(roles.includes(source.speaker),`dialog_facts: недопустимая роль источника (${label}).`);
    }
  };
  const checked=(items,label)=>{
    list(items,label);
    for(const r of items){
      const first=byId.get(r?.from_message_id),last=byId.get(r?.to_message_id);
      requireThat(keys(r,['from_message_id','to_message_id','expected_action'])&&first&&last&&first.index<=last.index&&nonempty(r.expected_action),
        `dialog_facts: неверный диапазон (${label}).`);
    }
  };
  const language=facts.client_language;
  requireThat(keys(language,['languages','certainty','explanation','evidence'])&&['supported','uncertain'].includes(language.certainty)&&nonempty(language.explanation),
    'dialog_facts: неверное наблюдение о языке клиента.');
  list(language.languages,'languages');
  requireThat(language.languages.every(v=>['RU','KZ','EN','other'].includes(v))&&new Set(language.languages).size===language.languages.length,
    'dialog_facts: неверные языки или повторные значения.');
  quotes(language.evidence,'client_language',['client']);
  const firstClient=messages.find(m=>m.speaker==='client');
  if(language.certainty==='supported'){
    requireThat(language.languages.length>0&&firstClient&&language.evidence.some(e=>e.message_id===firstClient.message_id),
      'dialog_facts: язык должен опираться на первую реплику клиента.');
  }
  requireThat(facts.first_operator_message_id===(messages.find(m=>m.speaker==='operator')?.message_id??null),
    'dialog_facts: неверно указан первый ответ человека-оператора.');
  list(facts.client_questions,'client_questions');
  const questionIds=new Set();
  for(const q of facts.client_questions){
    requireThat(keys(q,['question_id','summary','evidence','operator_responses','response_state','checked_ranges','missing_information'])&&nonempty(q.question_id)&&!questionIds.has(q.question_id)&&nonempty(q.summary),
      'dialog_facts: неверный или повторный вопрос клиента.');
    questionIds.add(q.question_id);quotes(q.evidence,'client_question',['client']);
    requireThat(q.evidence.length>0,'dialog_facts: вопрос клиента должен иметь цитату.');
    list(q.operator_responses,'operator_responses');
    for(const response of q.operator_responses){
      requireThat(keys(response,['summary','evidence'])&&nonempty(response.summary),'dialog_facts: неверное описание ответа оператора.');
      quotes(response.evidence,'operator_response',['operator']);
      requireThat(response.evidence.length>0,'dialog_facts: ответ оператора должен иметь цитату.');
    }
    checked(q.checked_ranges,'question.checked_ranges');textList(q.missing_information,'question.missing_information');
    requireThat(['present','not_observed','uncertain'].includes(q.response_state),'dialog_facts: неизвестное состояние ответа.');
    if(q.response_state==='present')requireThat(q.operator_responses.length>0,'dialog_facts: present требует ответа оператора.');
    if(q.response_state==='not_observed')requireThat(q.operator_responses.length===0&&q.checked_ranges.length>0,'dialog_facts: отсутствие ответа требует проверенного участка.');
    if(q.response_state==='uncertain')requireThat(q.missing_information.length>0,'dialog_facts: объясните неопределённость ответа.');
  }
  list(facts.context_events,'context_events');
  for(const event of facts.context_events){
    requireThat(keys(event,['kind','summary','evidence'])&&['verification_confirmation','handoff','closure','other'].includes(event.kind)&&nonempty(event.summary),
      'dialog_facts: неверное событие контекста.');
    quotes(event.evidence,'context_event',['bot','system']);
    requireThat(event.evidence.length>0,'dialog_facts: событие контекста должно иметь цитату.');
  }
  list(facts.observations,'observations');
  for(const observation of facts.observations){
    requireThat(keys(observation,['kind','statement','basis','evidence','checked_ranges','uncertainty_reason'])&&
      ['known_context','complaint','operator_statement','interaction','other'].includes(observation.kind)&&nonempty(observation.statement)&&
      ['direct_quote','checked_absence','uncertain'].includes(observation.basis)&&typeof observation.uncertainty_reason==='string',
      'dialog_facts: неверное наблюдение.');
    quotes(observation.evidence,'observation');checked(observation.checked_ranges,'observation.checked_ranges');
    if(observation.basis==='direct_quote')requireThat(observation.evidence.length>0,'dialog_facts: direct_quote требует точной цитаты.');
    if(observation.basis==='checked_absence')requireThat(observation.checked_ranges.length>0,'dialog_facts: checked_absence требует диапазона.');
    if(observation.basis==='uncertain')requireThat(nonempty(observation.uncertainty_reason),'dialog_facts: нужно объяснение неопределённости наблюдения.');
  }
  textList(facts.limitations,'limitations');
  return facts;
}
