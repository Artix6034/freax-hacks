import { hash, requireThat, validateChecklist, nonempty, naAllowed, reviewStatus } from '../domain.js';
import { buildDialogFactsSchema, validateDialogFacts } from './facts.js';

export const SCHEMA_VERSION = 'cqa-facts-schema-1.1-source-roles';
const object = properties => ({ type:'object', properties, required:Object.keys(properties), additionalProperties:false });
const str = { type:'string' };
const valueSchema = values => {
  const variants=[...new Set(values.map(v=>typeof v))].map(type=>({type,enum:values.filter(v=>typeof v===type)}));
  return variants.length === 1 ? variants[0] : {anyOf:variants};
};

// A required property per criterion guarantees different value enums by ID.
// Nested anyOf permits an honest unresolved run without inventing N/A.
export function buildReviewSchema(checklist, channel, conversation) {
  validateChecklist(checklist);
  const defs={ evidence:object({message_id:str,quote:str}), range:object({from_message_id:str,to_message_id:str,expected_action:{type:'string',minLength:1}}) };
  let sourceRefs;
  if(conversation){
    const messages=conversation.transcript;
    // Shared definitions avoid repeating enum values in every criterion. Larger
    // transcripts use an exact-ID pattern to stay below provider enum limits.
    const idSchema=ids=>ids.length===0 ? {type:'string',pattern:'^$'} : messages.length<=250 ? {type:'string',enum:ids} :
      {type:'string',pattern:`^(?:${ids.join('|')})$`};
    defs.evidence=object({message_id:idSchema(messages.map(m=>m.message_id)),quote:str});
    for(const [role,allowed] of Object.entries({client:['client'],operator:['operator'],context:['bot','system']})){
      defs[`evidence_${role}`]=object({message_id:idSchema(messages.filter(m=>allowed.includes(m.speaker)).map(m=>m.message_id)),quote:str});
    }
    sourceRefs={client:'#/$defs/evidence_client',operator:'#/$defs/evidence_operator',context:'#/$defs/evidence_context',firstOperator:messages.find(m=>m.speaker==='operator')?.message_id??null,
      emptyRoles:Object.entries({client:['client'],operator:['operator'],context:['bot','system']}).filter(([,roles])=>!messages.some(m=>roles.includes(m.speaker))).map(([role])=>role)};
  }
  const criteria = Object.fromEntries(checklist.criteria.map(c => [c.id, {
    anyOf:[object({ criterion_id:{type:'string',enum:[c.id]},status:{type:'string',enum:['resolved']},value:valueSchema(c.allowed_values.filter(v=>v!=='na'||naAllowed(c,channel))), explanation:str,
      evidence:{type:'array',items:{$ref:'#/$defs/evidence'}},
      checked_ranges:{type:'array',items:{$ref:'#/$defs/range'}}, na_reason:str,na_condition:{type:'string',enum:c.na_condition?['',c.na_condition]:['']},missing_information:{type:'array',items:str} }),
      object({criterion_id:{type:'string',enum:[c.id]},status:{type:'string',enum:['unresolved']},value:{type:'null'},explanation:str,evidence:{type:'array',items:{$ref:'#/$defs/evidence'}},checked_ranges:{type:'array',items:{$ref:'#/$defs/range'}},na_reason:{type:'string',enum:['']},na_condition:{type:'string',enum:['']},missing_information:{type:'array',items:str}})],
    description:JSON.stringify({name:c.name,instruction:c.instruction,na_rule:c.na_rule,na_channels:c.na_channels,na_condition:c.na_condition,scale:c.scale,evidence_policy:c.evidence_policy})
  }]));
  return {
    ...object({dialog_facts:{anyOf:[buildDialogFactsSchema(sourceRefs),{type:'null'}]},evaluations:{anyOf:[
      object({status:{type:'string',enum:['completed','partial']},criteria_by_id:object(criteria),limitation:{type:'null'}}),
      object({status:{type:'string',enum:['unresolved']},criteria_by_id:{type:'null'},limitation:str})
    ]}}),
    description:`${SCHEMA_VERSION}; checklist sha256:${hash(checklist)}; channel:${channel ?? 'unspecified'}`,
    $defs:defs
  };
}

export function decodeSchemaResponse(payload, checklist, conversation) {
  const result=payload?.evaluations;
  requireThat(result && typeof result === 'object' && Object.keys(payload).length === 2 && Object.hasOwn(payload,'dialog_facts'), 'Неверная оболочка dialog_facts → evaluations.');
  requireThat(Object.keys(result).length === 3 && ['status','criteria_by_id','limitation'].every(k=>Object.hasOwn(result,k)), 'Неполная оболочка строгого ответа AI.');
  if (result.status === 'unresolved') {
    requireThat(payload.dialog_facts===null&&result.criteria_by_id === null && nonempty(result.limitation), 'Нужно объяснение технического ограничения AI.');
    return { limitation:result.limitation };
  }
  requireThat(['completed','partial'].includes(result.status) && result.limitation === null && result.criteria_by_id && typeof result.criteria_by_id === 'object' && !Array.isArray(result.criteria_by_id), 'Неверный статус строгого ответа AI.');
  const ids=checklist.criteria.map(c=>c.id);
  requireThat(Object.keys(result.criteria_by_id).length === ids.length && ids.every(id=>Object.hasOwn(result.criteria_by_id,id)), 'AI должен вернуть все критерии строгой схемы.');
  const criteria=ids.map(id=>{
    const row=result.criteria_by_id[id];
    requireThat(row?.criterion_id === id, 'ID в строгом ответе не совпадает с ключом критерия.');
    return row;
  });
  requireThat(result.status===reviewStatus({criteria}),'Статус оболочки не соответствует определённости критериев.');
  validateDialogFacts(payload.dialog_facts,conversation);
  return { review:{criteria},dialogFacts:payload.dialog_facts };
}
