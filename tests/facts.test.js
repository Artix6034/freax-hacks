import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeConversation,hash} from '../src/domain.js';
import {buildReviewSchema,decodeSchemaResponse} from '../src/ai/schema.js';
import {validateDialogFacts,buildDialogFactsSchema} from '../src/ai/facts.js';
import {buildMessages,createProvider,providerConfig} from '../src/ai/provider.js';
import {EvaluationService} from '../src/service.js';
import {factsFixture,reviewEnvelope} from './fixtures/dialog-facts.js';
const checklist=JSON.parse(await readFile(new URL('../config/checklist.v1.json',import.meta.url)));
const conversation=normalizeConversation({conversation_id:'SYNTHETIC-facts-only',channel:'agent chat',language:'RU',transcript:[
  {speaker:'bot',timestamp:'00:00',text:'Добро пожаловать.'},
  {speaker:'client',timestamp:'00:01',text:'Здравствуйте! Какой тариф и как сменить адрес?'},
  {speaker:'system',timestamp:'00:02',text:'Клиент успешно верифицирован.'},
  {speaker:'operator',timestamp:'00:03',text:'Здравствуйте! Я Анна. Тариф 123. Адрес можно сменить в профиле.'}
]});
const ev=i=>({message_id:conversation.transcript[i].message_id,quote:conversation.transcript[i].text});
const range={from_message_id:'m0001',to_message_id:'m0004',expected_action:'TEST: проверка всего диалога'};
function facts(){const f=factsFixture(conversation);f.client_questions=[{question_id:'q1',summary:'TEST: вопрос о тарифе',evidence:[ev(1)],
  operator_responses:[{summary:'TEST: оператор назвал тариф 123, правильность не установлена',evidence:[ev(3)]}],response_state:'present',checked_ranges:[],missing_information:[]}];
  f.context_events=[{kind:'verification_confirmation',summary:'TEST: системное подтверждение',evidence:[ev(2)]}];
  f.observations=[{kind:'operator_statement',statement:'TEST: оператор сказал «Тариф 123»; истинность не проверена',basis:'direct_quote',evidence:[ev(3)],checked_ranges:[],uncertainty_reason:''}];return f;}
function review(){return {criteria:checklist.criteria.map(c=>({criterion_id:c.id,status:'resolved',value:c.type==='flag'?'no':c.type==='scale'?c.scale.at(-1).value:'yes',explanation:'TEST ONLY',
  evidence:c.type==='flag'?[]:[ev(3)],checked_ranges:[structuredClone(range)],na_reason:'',na_condition:'',missing_information:[]}))};}
const config=providerConfig({AI_PROVIDER:'local',AI_BASE_URL:'http://test.invalid/v1',AI_MODEL:'TEST ONLY',AI_RESPONSE_FORMAT:'json_schema'});
const response=payload=>({ok:true,status:200,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]})});
const store=()=>({async write(id,r){return structuredClone(r);}});

test('published facts contract matches runtime schema and keeps legacy and new metadata readable',async()=>{
  const contract=JSON.parse(await readFile(new URL('../contracts/cqa.schema.json',import.meta.url)));
  assert.deepEqual(contract.$defs.DialogFacts,buildDialogFactsSchema());
  assert.ok(!contract.$defs.Evaluation.required.includes('ai_facts'));
  for(const pipeline of ['A1','facts-then-evaluations']){
    assert.ok(contract.$defs.AIExecutionMetadata.properties.pipeline.enum.includes(pipeline));
    assert.ok(contract.$defs.AICall.properties.stage.enum.includes(pipeline));
  }
});

test('facts precede evaluations in strict schema and both are required; arbitrary current rubric is retained',()=>{
  const dynamic=structuredClone(checklist);dynamic.criteria.push({...structuredClone(checklist.criteria[0]),id:'custom-new-rule',name:'TEST arbitrary rule'});
  const schema=buildReviewSchema(dynamic,conversation.channel);
  assert.deepEqual(Object.keys(schema.properties),['dialog_facts','evaluations']);assert.deepEqual(schema.required,['dialog_facts','evaluations']);
  assert.ok(schema.properties.evaluations.anyOf[0].properties.criteria_by_id.required.includes('custom-new-rule'));
  assert.match(buildMessages(conversation,dynamic)[0].content,/SINGLE response/);
  assert.match(buildMessages(conversation,dynamic)[0].content,/not a replacement for the transcript/);
});
test('fact citations validate exact original role, quote, first operator and bot/system context',()=>{
  assert.deepEqual(validateDialogFacts(facts(),conversation),facts());
  for(const mutate of [f=>f.first_operator_message_id='m0001',f=>f.client_language.evidence=[ev(3)],
    f=>f.client_questions[0].evidence=[ev(3)],f=>f.client_questions[0].operator_responses[0].evidence=[ev(2)],
    f=>f.context_events[0].evidence=[ev(3)],f=>f.observations[0].evidence[0].quote='INVENTED',
    f=>f.client_questions.push(structuredClone(f.client_questions[0])),f=>delete f.limitations]){
    const f=facts();mutate(f);assert.throws(()=>validateDialogFacts(f,conversation),/dialog_facts/);
  }
});

test('source-bound output schema prevents client/operator IDs in bot/system events before generation',()=>{
  const schema=buildReviewSchema(checklist,conversation.channel,conversation),defs=schema.$defs;
  assert.deepEqual(defs.evidence_context.properties.message_id.enum,['m0001','m0003']);
  assert.ok(!defs.evidence_context.properties.message_id.enum.includes('m0002'));
  assert.deepEqual(defs.evidence_client.properties.message_id.enum,['m0002']);
  assert.deepEqual(defs.evidence_operator.properties.message_id.enum,['m0004']);
  const facts=schema.properties.dialog_facts.anyOf[0].properties;
  assert.equal(facts.context_events.items.properties.evidence.items.$ref,'#/$defs/evidence_context');
  assert.equal(facts.client_questions.items.properties.evidence.items.$ref,'#/$defs/evidence_client');
  assert.deepEqual(facts.first_operator_message_id.enum,['m0004']);
  const withoutContext=normalizeConversation({...conversation,transcript:conversation.transcript.filter(m=>['client','operator'].includes(m.speaker))});
  assert.equal(buildReviewSchema(checklist,withoutContext.channel,withoutContext).properties.dialog_facts.anyOf[0].properties.context_events.items.properties.evidence.maxItems,0);
});

test('large transcripts retain exact role restrictions without exceeding provider enum budgets',()=>{
  const large=normalizeConversation({...conversation,transcript:Array.from({length:1001},(_,i)=>({speaker:i%2?'operator':'client',timestamp:'00:00',text:'TEST ONLY'}))});
  const schema=buildReviewSchema(checklist,large.channel,large),id=schema.$defs.evidence_operator.properties.message_id;
  assert.ok(new RegExp(id.pattern).test('m0002'));assert.ok(!new RegExp(id.pattern).test('m0001'));assert.ok(!new RegExp(id.pattern).test('m9999'));
});
test('absence and uncertainty require honest ranges/missing information, not invented responses',()=>{
  const f=facts(),q=f.client_questions[0];q.response_state='not_observed';q.operator_responses=[];q.checked_ranges=[structuredClone(range)];validateDialogFacts(f,conversation);
  q.checked_ranges[0].expected_action='';assert.throws(()=>validateDialogFacts(f,conversation));q.checked_ranges=[structuredClone(range)];
  q.response_state='uncertain';assert.throws(()=>validateDialogFacts(f,conversation));q.missing_information=['TEST: реплика неоднозначна'];validateDialogFacts(f,conversation);
  f.observations[0]={kind:'other',statement:'TEST: проверенное отсутствие',basis:'checked_absence',evidence:[],checked_ranges:[],uncertainty_reason:''};
  assert.throws(()=>validateDialogFacts(f,conversation));f.observations[0].checked_ranges=[range];validateDialogFacts(f,conversation);
});
test('present response does not force consultation score; unknown and N/A remain different in the same call',async()=>{
  const r=review();Object.assign(r.criteria[3],{status:'unresolved',value:null,evidence:[],checked_ranges:[],missing_information:['TEST: официальный тариф отсутствует']});
  Object.assign(r.criteria[1],{value:'na',na_reason:'TEST: данные изначально достаточны'});
  const payload=reviewEnvelope(conversation,r);payload.dialog_facts=facts();let calls=0;
  const provider=createProvider(config,async()=>{calls++;return response(payload);});
  const record=await new EvaluationService(store(),provider).evaluate(conversation,checklist);
  assert.equal(calls,1);assert.equal(record.status,'partial');assert.equal(record.original_score.total,null);assert.equal(record.ai_review.criteria.length,8);
  assert.equal(record.ai_review.criteria[1].value,'na');assert.equal(record.ai_review.criteria[3].value,null);assert.equal(record.ai_review.criteria[0].value,'yes');
  assert.deepEqual(record.ai_facts,facts());assert.equal(record.ai_metadata.dialog_facts_hash,hash(facts()));
});
test('missing/null/invented facts cannot silently fall back to a bare review or create a valid score',async()=>{
  const payload=reviewEnvelope(conversation,review());
  for(const broken of [review(),{...payload,dialog_facts:null},{evaluations:payload.evaluations},
    {...payload,dialog_facts:{...facts(),first_operator_message_id:'m0003'}}]){
    let calls=0;const provider=createProvider(config,async()=>{calls++;return response(broken);});
    const record=await new EvaluationService(store(),provider).evaluate(conversation,checklist);
    assert.equal(calls,1);assert.equal(record.status,'failed');assert.equal(record.ai_facts,null);assert.equal(record.ai_review,null);assert.equal(record.original_score,null);
  }
  assert.throws(()=>decodeSchemaResponse({...payload,evaluations:{...payload.evaluations,status:'partial'}},checklist,conversation),/Статус/);
});
