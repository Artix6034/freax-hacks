import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveEvidence, renderEvidenceHTML } from '../src/web/evidence.js';

// Synthetic presentation data; not an AI result, organizer transcript or GT.
const conversation={transcript:[
  {message_id:'m0001',timestamp:'2026-11-07T11:00:00+05:00',speaker:'client',text:'TEST: earlier context'},
  {message_id:'m0002',timestamp:'2026-11-07T11:00:01+05:00',speaker:'operator',text:'TEST: observed <action> & text'},
  {message_id:'m0003',timestamp:'2026-11-07T11:00:02+05:00',speaker:'system',text:'TEST: identity confirmed'},
  {message_id:'m0004',timestamp:'2026-11-07T11:00:03+05:00',speaker:'operator',text:'TEST: later answer'},
  {message_id:'m0005',timestamp:'2026-11-07T11:00:04+05:00',speaker:'client',text:'TEST: following context'}
]};
const review={criterion_id:'TEST',value:'yes',explanation:'TEST only',na_reason:'',
  evidence:[{message_id:'m0002',quote:'observed <action> & text',timestamp:'FAKE_AI_TIME',speaker:'bot'}],
  checked_ranges:[{from_message_id:'m0002',to_message_id:'m0004',expected_action:'TEST: expected action',from_timestamp:'FAKE_AI_TIME'}]};

test('evidence cards derive exact time/role and boundary context from saved conversation, without mutating original',()=>{
  const before=structuredClone({conversation,review});const cards=deriveEvidence(review,conversation);
  assert.equal(cards[0].timestamp,conversation.transcript[1].timestamp);assert.equal(cards[0].speaker,'operator');
  assert.equal(cards[0].quote,review.evidence[0].quote);
  assert.deepEqual(cards[0].context.map(m=>m.message_id),['m0001','m0002','m0003']);
  assert.equal(cards[0].context[0].selected,false);assert.equal(cards[0].context[1].selected,true);
  assert.equal(cards[1].from_timestamp,conversation.transcript[1].timestamp);assert.equal(cards[1].to_timestamp,conversation.transcript[3].timestamp);
  assert.deepEqual(cards[1].context.filter(m=>!m.selected).map(m=>m.message_id),['m0001','m0005']);
  assert.deepEqual({conversation,review},before);
  assert.equal(Object.hasOwn(cards[0],'audio_offset'),false);
});
test('evidence HTML distinguishes quotes and checked ranges, escapes source text and uses no AI-authored times',()=>{
  const html=renderEvidenceHTML(review,conversation);
  assert.match(html,/Сообщение-доказательство/);assert.match(html,/Проверенный участок/);
  assert.match(html,/2026-11-07T11:00:01\+05:00/);assert.match(html,/Оператор/);
  assert.match(html,/observed &lt;action&gt; &amp; text/);assert.doesNotMatch(html,/<action>/);
  assert.doesNotMatch(html,/FAKE_AI_TIME/);assert.match(html,/Ожидалось \/ проверялось: TEST: expected action/);
  assert.match(html,/Соседнее сообщение/);assert.match(html,/data-from="m0002" data-to="m0004"/);
});
test('empty or unavailable sources remain presentation limitations, not automatic semantic judgments',()=>{
  const empty=renderEvidenceHTML({...review,evidence:[],checked_ranges:[]},conversation);
  assert.match(empty,/не подтверждается и не опровергается/);
  const unavailable=deriveEvidence({...review,evidence:[{message_id:'missing',quote:'TEST'}],checked_ranges:[]},conversation);
  assert.equal(unavailable[0].available,false);
  assert.equal(Object.hasOwn(unavailable[0],'value'),false);
});
