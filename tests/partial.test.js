import {factsFixture,reviewEnvelope} from './fixtures/dialog-facts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateReview, normalizeConversation, hash } from '../src/domain.js';
import { calculate } from '../src/scoring.js';
import { EvaluationService } from '../src/service.js';
import { buildReviewSchema } from '../src/ai/schema.js';
import { createProvider, providerConfig } from '../src/ai/provider.js';
import { filterHistory } from '../src/history.js';
const checklist=JSON.parse(await readFile(new URL('../config/checklist.v1.json',import.meta.url)));
const updated=JSON.parse(await readFile(new URL('../config/checklist.organizer-2026-11-07.json',import.meta.url)));
const conversation=normalizeConversation(JSON.parse(await readFile(new URL('./fixtures/transcripts/synthetic.json',import.meta.url))));
// Artificial answers: mechanics only; never organizer data, independent labels or real AI.
const review=()=>({criteria:checklist.criteria.map(c=>({criterion_id:c.id,status:'resolved',value:c.type==='flag'?'no':c.type==='scale'?Math.max(...c.scale.map(s=>s.value)):'yes',explanation:'TEST ONLY',missing_information:[],na_reason:'',na_condition:'',evidence:c.type==='flag'?[]:[{message_id:'m0002',quote:'Я Анна.'}],checked_ranges:[{from_message_id:'m0001',to_message_id:'m0005',expected_action:'TEST checked range'}]}))});
function unresolved(r,id){Object.assign(r.criteria.find(c=>c.criterion_id===id),{status:'unresolved',value:null,explanation:'TEST: no authoritative product reference',missing_information:['TEST: official rule effective at the conversation date'],evidence:[],checked_ranges:[],na_reason:'',na_condition:''});return r;}
const store=()=>({records:new Map(),async write(id,r){this.records.set(id,structuredClone(r));return r;},async read(id){return structuredClone(this.records.get(id));},async transaction(fn){return fn();}});

test('partial weighted criterion preserves known answers and raw points, blocks global weights and total',()=>{
  const r=unresolved(review(),'04');validateReview(r,checklist,conversation);
  const score=calculate(checklist,r,conversation.channel);
  assert.equal(score.total,null);assert.equal(score.status,'partial');assert.equal(score.resolved_count,7);assert.equal(score.unresolved_count,1);
  assert.equal(score.criteria[0].raw_points,10);assert.equal(score.criteria[3].raw_points,null);
  assert.equal(score.applicable_weight,null);assert.ok(score.criteria.every(c=>c.contribution===null&&c.effective_weight===null));
  assert.ok(score.sections.every(s=>s.contribution===null&&s.effective_weight===null));assert.match(score.total_reason,/неопределённые/);
  r.criteria[1].value='na';r.criteria[1].na_reason='TEST: sufficient initial details';
  validateReview(r,checklist,conversation);assert.equal(calculate(checklist,r).total,null);assert.equal(r.criteria[1].status,'resolved');
});
test('only unresolved flag allows numeric total; unknown is not no; confirmed violation wins',()=>{
  const r=unresolved(review(),'08');validateReview(r,checklist,conversation);
  const score=calculate(checklist,r);assert.equal(score.total,100);assert.equal(score.gross_error,null);assert.equal(score.status,'partial');
  const c=structuredClone(checklist);c.criteria.push({...structuredClone(c.criteria[7]),id:'another-flag'});
  r.criteria.push({...structuredClone(review().criteria[0]),criterion_id:'another-flag',value:'yes'});
  validateReview(r,c,conversation);assert.equal(calculate(c,r).gross_error,true);assert.equal(calculate(c,r).total,100);
});
test('partial still rejects broken IDs, invented sources, invalid steps, forbidden NA and malformed unresolved',()=>{
  for(const mutate of [r=>r.criteria[0].criterion_id='unknown',r=>r.criteria[1].criterion_id='01',r=>r.criteria.pop(),
    r=>r.criteria[0].value='na',r=>r.criteria[5].value=6,r=>r.criteria[3].evidence.push({message_id:'m0002',quote:'INVENTED'}),
    r=>r.criteria[3].missing_information=[],r=>r.criteria[3].value='na',r=>delete r.criteria[3].status]){
    const r=unresolved(review(),'04');mutate(r);assert.throws(()=>validateReview(r,checklist,conversation));
  }
});
test('AI partial remains immutable after human resolution and final completed status',async()=>{
  const original=unresolved(review(),'04'),memory=store();
  const service=new EvaluationService(memory,{evaluate:async()=>({review:structuredClone(original),metadata:{provider:'TEST ONLY',model:'TEST ONLY'}})});
  let r=await service.evaluate(conversation,checklist);assert.equal(r.ai_status,'partial');assert.equal(r.final_status,'partial');assert.equal(r.status,'partial');
  const before=structuredClone(r);
  r=await service.appeal(r.evaluation_id,{revision:r.revision,criterion_id:'04',comment:'TEST: authoritative information supplied'});
  const replacement=review().criteria[3];
  r=await service.resolve(r.evaluation_id,{revision:r.revision,appeal_id:r.appeals[0].appeal_id,action:'change',reason:'TEST human reason',review:replacement});
  assert.equal(r.status,'completed');assert.equal(r.final_status,'completed');assert.equal(r.ai_status,'partial');
  assert.equal(r.final_score.total,100);assert.equal(r.original_score.total,null);assert.deepEqual(r.ai_review,before.ai_review);assert.deepEqual(r.checklist,before.checklist);
  const known=await new EvaluationService(store(),{evaluate:async()=>({review:review(),metadata:{}})}).evaluate(conversation,checklist);
  assert.equal(known.ai_status,'completed');
});
test('partial strict transport retains all rows; broken response remains failed',async()=>{
  const output=unresolved(review(),'04');const config=providerConfig({AI_PROVIDER:'local',AI_BASE_URL:'http://test.invalid/v1',AI_MODEL:'TEST ONLY',AI_RESPONSE_FORMAT:'json_schema'});
  let calls=0;
  const payload=reviewEnvelope(conversation,output);
  const provider=createProvider(config,async()=>{calls++;return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]})};});
  const r=await new EvaluationService(store(),provider).evaluate(conversation,checklist);
  assert.equal(r.status,'partial');assert.equal(r.ai_review.criteria.length,8);assert.equal(calls,1);assert.equal(r.original_score.total,null);
  const bad=createProvider(config,async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{BROKEN'}}]})}));
  assert.equal((await new EvaluationService(store(),bad).evaluate(conversation,checklist)).status,'failed');
});
test('strict range schema excludes empty expected_action and semantic validator still rejects empty ranges',()=>{
  const schema=buildReviewSchema(checklist,'agent chat');
  assert.equal(schema.$defs.range.properties.expected_action.minLength,1);
  const r=review();r.criteria[1].checked_ranges[0].expected_action='';
  assert.throws(()=>validateReview(r,checklist,conversation),/диапазон 02/);
});
test('organizer voice NA is versioned and channel/condition gated, not blanket no-greeting NA',()=>{
  const voice=structuredClone(conversation);voice.channel='voice call';voice.transcript.forEach((m,i)=>m.timestamp=`2026-11-07T12:00:0${i}+05:00`);
  voice.transcript[0].speaker='system';voice.transcript[0].text='TEST: recording began after the operator greeting';
  const r=review();Object.assign(r.criteria[0],{value:'na',na_reason:'TEST: confirmed late recording start',na_condition:'recording_started_after_greeting',evidence:[{message_id:'m0001',quote:voice.transcript[0].text}]});
  assert.throws(()=>validateReview(r,checklist,voice));validateReview(r,updated,voice);
  assert.throws(()=>validateReview(r,updated,conversation),/канала/);
  const noCondition=structuredClone(r);noCondition.criteria[0].na_condition='';assert.throws(()=>validateReview(noCondition,updated,voice),/условие/);
  const noReason=structuredClone(r);noReason.criteria[0].na_reason='';assert.throws(()=>validateReview(noReason,updated,voice));
  const chatSchema=buildReviewSchema(updated,'agent chat'),voiceSchema=buildReviewSchema(updated,'voice call');
  const values=s=>s.properties.evaluations.anyOf[0].properties.criteria_by_id.properties['01'].anyOf[0].properties.value.enum;
  assert.equal(values(chatSchema).includes('na'),false);assert.equal(values(voiceSchema).includes('na'),true);
  assert.equal(checklist.criteria[0].allow_na,false);assert.notEqual(hash(checklist),hash(updated));
});
test('history filters separate unknown/no and expose original partial vs completed final after human change',()=>{
  const base={evaluation_id:'TEST',created_at:'2026-11-07T00:00:00Z',conversation,checklist,appeals:[],ai_review:review(),final_review:review(),status:'completed',original_score:calculate(checklist,review()),final_score:calculate(checklist,review())};
  const pending={...structuredClone(base),evaluation_id:'UNKNOWN',status:'partial',ai_status:'partial',final_status:'partial',ai_review:unresolved(review(),'08'),final_review:unresolved(review(),'08')};
  pending.original_score=calculate(checklist,pending.ai_review);pending.final_score=calculate(checklist,pending.final_review);
  const human={...structuredClone(pending),evaluation_id:'HUMAN',status:'completed',final_status:'completed',final_review:review(),final_score:calculate(checklist,review()),appeals:[{status:'resolved'}]};
  const records=[base,pending,human];
  assert.deepEqual(filterHistory(records,new URLSearchParams('gross_error=unknown')).map(r=>r.evaluation_id),['UNKNOWN']);
  assert.equal(filterHistory(records,new URLSearchParams('gross_error=no')).length,2);
  const originals=filterHistory(records,new URLSearchParams('view=original&gross_error=unknown&status=partial'));
  assert.equal(originals.length,2);assert.equal(originals.find(r=>r.evaluation_id==='HUMAN').final_status,'completed');
  assert.equal(filterHistory(records,new URLSearchParams('conversation_id=synthetic&checklist_version=1')).length,3);
});
