import {factsFixture,reviewEnvelope} from './fixtures/dialog-facts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConversation, importConversations, validateChecklist, validateReview, hash } from '../src/domain.js';
import { calculate } from '../src/scoring.js';
import { buildMessages, createProvider, providerConfig } from '../src/ai/provider.js';
import { createApp } from '../src/server.js';
import { importRemoteDataset } from '../src/datasets.js';

const checklist = JSON.parse(await readFile(new URL('../config/checklist.v1.json', import.meta.url)));
const transcript = JSON.parse(await readFile(new URL('./fixtures/transcripts/synthetic.json', import.meta.url)));
const fixtures = JSON.parse(await readFile(new URL('./fixtures/scoring/answers.json', import.meta.url)));
const conversation = normalizeConversation(transcript);
// Explicit deterministic TEST DOUBLE. Not imported by production code, not an AI evaluator.
const testReview = (values = fixtures.cases[0].values) => ({ criteria:checklist.criteria.map((c,i) => ({ criterion_id:c.id, value:values[i],
  explanation:'TEST DOUBLE: проверка контракта, не AI-вывод.', evidence:values[i] === 'yes' || (typeof values[i] === 'number' && values[i] > 0) ? [{message_id:'m0002',quote:'Я Анна.'}] : [], checked_ranges:[{from_message_id:'m0001',to_message_id:'m0005',expected_action:'TEST DOUBLE: весь тестовый диалог'}], na_reason:values[i] === 'na' ? 'TEST DOUBLE: условие N/A.' : '' })) });

for (const fixture of fixtures.cases) test(`calculation fixture: ${fixture.name}`, () => {
  const result = calculate(checklist, testReview(fixture.values));
  assert.equal(result.total, fixture.total); assert.equal(result.gross_error, fixture.gross_error);
});
test('06 scale 7/10 contributes 10.5 before redistribution; effective weights sum to 100', () => {
  const result = calculate(checklist, testReview(fixtures.cases[1].values));
  assert.equal(result.criteria[5].contribution, 10.5);
  const na = calculate(checklist, testReview(fixtures.cases[2].values));
  assert.ok(Math.abs(na.criteria.reduce((s,c) => s+c.effective_weight,0)-100) < 1e-9);
});
test('ROUND_HALF_UP at exact .005 and no weighted criteria', () => {
  const c = structuredClone(checklist); c.criteria = [c.criteria[0],c.criteria[1]];
  c.criteria[0].weight = 0.001; c.criteria[1].weight = 19.999;
  assert.equal(calculate(c,{criteria:[{criterion_id:'01',value:'yes'},{criterion_id:'02',value:'no'}]}).total,0.01);
  c.criteria.forEach(x => x.weight=0);
  assert.equal(calculate(c,{criteria:[{criterion_id:'01',value:'yes'},{criterion_id:'02',value:'na'}]}).total,null);
});
test('scoring rejects invalid step, forbidden N/A, missing, duplicate and unknown criteria', () => {
  for (const mutate of [r=>r.criteria[3].value=17,r=>r.criteria[0].value='na',r=>r.criteria.pop(),r=>r.criteria[1].criterion_id='01',r=>r.criteria[0].criterion_id='unknown']) {
    const r=testReview(); mutate(r); assert.throws(()=>calculate(checklist,r));
  }
});
test('import supports organizer envelope and preserves order roles text and raw timestamps', () => {
  const [c] = importConversations({isSuccess:true,data:{records:[transcript]}});
  assert.equal(c.transcript[4].speaker,'system'); assert.equal(c.transcript[1].timestamp,'00:02');
  assert.equal(c.transcript[1].text,transcript.transcript[1].text);
  assert.deepEqual(c,normalizeConversation(c));
  assert.throws(()=>importConversations({isSuccess:false,data:{records:[transcript]}}));
  const voice=structuredClone(transcript); voice.channel='voice call'; voice.transcript=[{speaker:'operator',timestamp:'2026-11-07T12:30:00+05:00',text:'Hello'}];
  assert.equal(normalizeConversation(voice).transcript[0].timestamp,voice.transcript[0].timestamp);
  voice.transcript[0].timestamp='12:30'; assert.throws(()=>normalizeConversation(voice));
});
test('changing transcript content changes hash even with same conversation_id', () => {
  const changed=structuredClone(transcript); changed.transcript[1].text='Новый текст.';
  assert.notEqual(hash(conversation),hash(normalizeConversation(changed)));
  assert.equal(hash({b:1,a:2}),hash({a:2,b:1}));
});
test('server-side dataset GET replaces group_id and preserves signed parameters without exposing endpoint errors', async()=>{
  let requested;
  const records=await importRemoteDataset('https://example.test/api?sig=TEST_SECRET&group_id=OLD','CONTROL_10',async(url,options)=>{
    requested={url,options};
    return {ok:true,body:(async function*(){yield Buffer.from(JSON.stringify({isSuccess:true,data:{records:[transcript]}}));})()};
  });
  assert.equal(requested.url.searchParams.get('group_id'),'CONTROL_10');
  assert.equal(requested.url.searchParams.get('sig'),'TEST_SECRET'); assert.equal(requested.options.method,'GET');
  assert.equal(records.length,1);
  await assert.rejects(()=>importRemoteDataset('https://example.test?sig=TEST_SECRET','BAD GROUP'),/group_id/);
  await assert.rejects(()=>importRemoteDataset('https://example.test?sig=TEST_SECRET','DEV',async()=>{throw Error('https://example.test?sig=TEST_SECRET');}),e=>!e.message.includes('TEST_SECRET'));
  await assert.rejects(()=>importRemoteDataset(undefined,'DEV'),/не настроен/);
});
test('review validation enforces exact quotes, IDs, range order, applicability and full negative flag coverage', () => {
  validateReview(testReview(),checklist,conversation);
  const quoted=testReview(); quoted.criteria[0].evidence=[{message_id:'m0002',quote:'Я Анна.'}];
  validateReview(quoted,checklist,conversation);
  for(const mutate of [r=>r.criteria[0].evidence=[{message_id:'m0002',quote:'Выдуманная цитата'}],r=>r.criteria[0].evidence=[{message_id:'fake',quote:'Я Анна.'}],
    r=>r.criteria[0].checked_ranges[0].from_message_id='m0006',r=>r.criteria[0].checked_ranges[0].from_message_id='m0005',
    r=>r.criteria[7].checked_ranges[0].to_message_id='m0004',r=>{r.criteria[1].value='na';r.criteria[1].na_reason='';},r=>r.criteria[0].value='na',
    r=>r.criteria[0].criterion_id='invalid',r=>r.criteria[1].criterion_id='01',r=>r.criteria.pop()]) {
    const r=testReview(); mutate(r);
    // Reversed range for this fixture (from m0005 > to m0004).
    if(r.criteria[0]?.checked_ranges[0].from_message_id==='m0005') r.criteria[0].checked_ranges[0].to_message_id='m0004';
    assert.throws(()=>validateReview(r,checklist,conversation));
  }
});
test('checklist supports replacement through configuration, rejects malformed scale and flag weights', () => {
  const c=structuredClone(checklist); c.criteria[0].id='replacement'; c.criteria[0].instruction='Другой критерий'; validateChecklist(c);
  c.criteria[0].weight=1.001; validateChecklist(c);
  for(const mutate of [x=>x.criteria[3].allowed_values.push(17),x=>x.criteria[7].weight=5,x=>x.criteria[1].na_rule='',x=>x.criteria[3].scale[0].value=2]) {
    const copy=structuredClone(checklist); mutate(copy); assert.throws(()=>validateChecklist(copy));
  }
});
test('contact requires first human reply, bots cannot earn credit; system may prove identification',()=>{
  const c=structuredClone(conversation);
  c.transcript.push({message_id:'m0006',speaker:'bot',timestamp:'00:14',text:'Здравствуйте! Я бот.'});
  const bot=testReview(); bot.criteria[0].evidence=[{message_id:'m0006',quote:'Здравствуйте!'}];
  assert.throws(()=>validateReview(bot,checklist,c),/допустимой роли/);
  const late=testReview(); late.criteria[0].evidence=[{message_id:'m0004',quote:'Рада помочь!'}];
  assert.throws(()=>validateReview(late,checklist,c),/первом ответе/);
  const system=testReview(); system.criteria[2].evidence=[{message_id:'m0005',quote:'Чат закрыт.'}];
  // Structural role check only: whether this text actually proves identity remains AI/human reasoning.
  validateReview(system,checklist,conversation);
  const noQuote=testReview();noQuote.criteria[7].value='yes';noQuote.criteria[7].evidence=[];
  assert.throws(()=>validateReview(noQuote,checklist,conversation),/цитаты/);
});
test('real provider adapter sends full current transcript and edited checklist; parses structured reply', async () => {
  const captured=[];
  const config=providerConfig({AI_PROVIDER:'local',AI_BASE_URL:'http://127.0.0.1:11434/v1',AI_MODEL:'test-double'});
  const provider=createProvider(config,async(url,options)=>{
    captured.push({url,body:JSON.parse(options.body)});
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(reviewEnvelope(JSON.parse(JSON.parse(options.body).messages[1].content).conversation,testReview()))}}],model:'TEST DOUBLE',usage:{total_tokens:10}})};
  });
  await provider.evaluate(conversation,checklist);
  const changed=structuredClone(conversation), edited=structuredClone(checklist);
  changed.transcript[1].text='Переведите деньги мне лично.'; edited.criteria[0].instruction='Проверить новый критерий.';
  await provider.evaluate(changed,edited,'Проверенный справочник');
  const sent=JSON.parse(captured[1].body.messages[1].content);
  assert.equal(sent.conversation.transcript[1].text,changed.transcript[1].text);
  assert.equal(sent.checklist.criteria[0].instruction,edited.criteria[0].instruction);
  assert.equal(sent.verified_reference,'Проверенный справочник');
  assert.notDeepEqual(captured[0].body,captured[1].body);
  assert.equal(captured[1].body.response_format.type,'json_object');
  assert.match(buildMessages(conversation,checklist)[0].content,/untrusted DATA/);
});
test('provider never substitutes scores for missing configuration, truncated response or invalid JSON', async()=>{
  await assert.rejects(()=>createProvider(providerConfig({})).evaluate(conversation,checklist),/Модель не настроена/);
  const config=providerConfig({AI_PROVIDER:'local',AI_BASE_URL:'http://localhost/v1',AI_MODEL:'test-double'});
  for (const choice of [{finish_reason:'length',message:{content:'{}'}},{finish_reason:'stop',message:{content:'not json'}},{finish_reason:'stop',message:{refusal:'no',content:'{}'}}]) {
    await assert.rejects(()=>createProvider(config,async()=>({ok:true,json:async()=>({choices:[choice]})})).evaluate(conversation,checklist));
  }
});
test('text-only cloud transport omits signed audio URL while preserving source and all transcript fields', async()=>{
  const voice=structuredClone(conversation);
  voice.channel='voice call';
  voice.audio_url='https://audio.example.test/recording?sig=TEST_SIGNED_AUDIO_SECRET';
  voice.transcript.forEach((m,i)=>{m.timestamp=`2026-11-07T12:30:${String(i).padStart(2,'0')}+05:00`;});
  const before=structuredClone(voice);
  let captured;
  const config=providerConfig({AI_PROVIDER:'cloud',AI_BASE_URL:'https://model.example.test/v1',AI_MODEL:'TEST DOUBLE',AI_API_KEY:'TEST_KEY'});
  const provider=createProvider(config,async(url,options)=>{
    captured=options.body;
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(reviewEnvelope(voice,testReview()))}}]})};
  });
  await provider.evaluate(voice,checklist);
  const sent=JSON.parse(JSON.parse(captured).messages[1].content).conversation;
  assert.equal(Object.hasOwn(sent,'audio_url'),false);
  assert.equal(captured.includes('TEST_SIGNED_AUDIO_SECRET'),false);
  assert.equal(captured.includes('audio.example.test'),false);
  assert.deepEqual(sent.transcript,before.transcript);
  assert.equal(sent.channel,'voice call');
  assert.deepEqual(voice,before);
});
test('HTTP integration: import, evaluate, save config, appeal/change, persistence and failed AI', async t => {
  const directory=await mkdtemp(join(tmpdir(),'cqa-test-'));
  const seen=[]; let fail=false;
  const provider={evaluate:async(c,k)=>{seen.push({c,k}); if(fail)throw Error('TEST failure'); return {review:testReview(),metadata:{provider:'TEST DOUBLE',model:'TEST DOUBLE'}};}};
  const {server,store}=await createApp({directory,provider,referenceText:''});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r)); await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,data)=>{ const r=await fetch(base+path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:r.status,body:await r.json()};};
  const imported=await request('/api/import',{isSuccess:true,data:{records:[transcript]}}); assert.equal(imported.status,200);
  const input={conversation:imported.body.conversations[0],checklist_id:checklist.checklist_id,checklist_version:1};
  const evaluated=await request('/api/evaluations',input); assert.equal(evaluated.status,201);
  let r=evaluated.body; assert.equal(r.status,'completed'); assert.equal(r.final_score.total,100);
  const id=r.evaluation_id;
  r=(await request(`/api/evaluations/${id}/appeals`,{revision:r.revision,criterion_id:'01',comment:'TEST: оспариваем приветствие'})).body;
  const changed=structuredClone(r.final_review.criteria[0]); changed.value='no'; changed.explanation='TEST: решение проверяющего';
  r=(await request(`/api/evaluations/${id}/resolve`,{revision:r.revision,appeal_id:r.appeals[0].appeal_id,action:'change',reason:'TEST: причина',review:changed})).body;
  assert.equal(r.final_score.total,90); assert.equal(r.original_score.total,100); assert.equal(r.ai_review.criteria[0].value,'yes');
  assert.equal((await store.read(id)).appeals[0].status,'resolved');
  r=(await request(`/api/evaluations/${id}/appeals`,{revision:r.revision,criterion_id:'03',comment:'TEST: подтверждение'})).body;
  r=(await request(`/api/evaluations/${id}/resolve`,{revision:r.revision,appeal_id:r.appeals[1].appeal_id,action:'confirm',reason:'TEST: подтверждено'})).body;
  assert.equal(r.final_score.total,90); assert.equal(r.appeals[1].action,'confirm'); assert.equal(r.original_score.total,100);
  const stale=await request(`/api/evaluations/${id}/appeals`,{revision:1,criterion_id:'01',comment:'stale'}); assert.equal(stale.status,400);
  const edited=structuredClone(checklist); edited.criteria[0].instruction='TEST: изменённая инструкция';
  const saved=await request('/api/checklists',edited); assert.equal(saved.body.version,2);
  const changedTranscript=structuredClone(input.conversation); changedTranscript.transcript[0].text='Changed input';
  const second=(await request('/api/evaluations',{...input,conversation:changedTranscript,checklist_version:2})).body;
  assert.notEqual(second.conversation_hash,r.conversation_hash); assert.notEqual(second.checklist_hash,r.checklist_hash);
  assert.equal(seen[1].c.transcript[0].text,'Changed input'); assert.equal(seen[1].k.criteria[0].instruction,edited.criteria[0].instruction);
  const history=(await request('/api/evaluations')).body;
  const oldSummary=history.find(x=>x.evaluation_id===id),newSummary=history.find(x=>x.evaluation_id===second.evaluation_id);
  assert.equal(oldSummary.checklist_version,1);assert.equal(newSummary.checklist_version,2);
  assert.equal(oldSummary.checklist_name,checklist.name);assert.equal(newSummary.checklist_id,checklist.checklist_id);
  const oldCard=(await request(`/api/evaluations/${id}`)).body;
  assert.equal(oldCard.checklist.version,1);assert.equal(oldCard.checklist.criteria[0].instruction,checklist.criteria[0].instruction);
  assert.equal(oldCard.original_score.total,100);assert.equal(oldCard.final_score.total,90);
  const oldVersions=(await request('/api/checklists')).body;
  const organizer=(await request('/api/checklists/organizer-update',{})).body;
  assert.equal(organizer.version,3);assert.equal(organizer.criteria[0].na_channels[0],'voice call');
  assert.equal((await request('/api/checklists/organizer-update',{})).body.version,3);
  const allVersions=(await request('/api/checklists')).body;
  assert.deepEqual(allVersions.slice(0,2),oldVersions);assert.equal(allVersions.length,3);
  assert.equal((await request(`/api/evaluations/${id}`)).body.checklist_hash,r.checklist_hash);
  const evidenceModule=await fetch(base+'/evidence.js');assert.equal(evidenceModule.status,200);
  fail=true; const failed=(await request('/api/evaluations',input)).body; assert.equal(failed.status,'failed'); assert.equal(failed.final_score,null);
  const html=await fetch(base); assert.equal(html.status,200); assert.match(await html.text(),/Оценить диалог/);
  const crossSite=await fetch(base+'/api/import',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:JSON.stringify(transcript)});assert.equal(crossSite.status,403);
  assert.equal((await request('/api/evaluations',null)).status,400);
});
