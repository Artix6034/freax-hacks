// EXPLICIT OFFLINE UI FIXTURE. Synthetic transcripts/results only, never AI or GT.
// Run manually: node tests/fixtures/ui/server.mjs
// All state lives in the OS temporary directory; no project data or .env is read.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createApp } from '../../../src/server.js';

const directory=await mkdtemp(join(tmpdir(),'cqa-offline-ui-'));
const checklist=JSON.parse(await readFile(new URL('../../../config/checklist.v1.json',import.meta.url),'utf8'));
checklist.name='СИНТЕТИЧЕСКИЙ ТЕСТ · чек-лист';
const conversation={conversation_id:'synthetic-offline-ui-only',channel:'voice call',language:'RU',audio_url:null,
  transcript:[
    ['bot','ТЕСТ: Добро пожаловать.'],
    ['client','ТЕСТ: Подскажите статус моего обращения.'],
    ['operator','ТЕСТ: Здравствуйте! Я Анна. Сначала подтвердите личность в приложении.'],
    ['system','ТЕСТ: Проверка личности завершена.'],
    ['operator','ТЕСТ: Обращение принято, ответ придёт в личный кабинет.'],
    ['client','ТЕСТ: Спасибо.'],
    ['operator','ТЕСТ: Проверили статус обращения. Если будут вопросы, обращайтесь. До свидания!'],
    ['system','ТЕСТ: Разговор завершён.']
  ].map(([speaker,text],i)=>({speaker,text,timestamp:`2026-11-07T12:00:${String(i*5).padStart(2,'0')}+05:00`}))};
let fixtureUnknown=[],fixtureFlag=false;
const provider={identity:{provider:'TEST DOUBLE',model:'TEST DOUBLE — NOT AI'},evaluate:async(c,k)=>({
  metadata:{provider:'TEST DOUBLE',model:'TEST DOUBLE — NOT AI'},
  review:{criteria:k.criteria.map(x=>{
    const m=c.transcript[x.id==='03'?3:x.id==='07'?6:x.id==='01'?2:4];
    if(fixtureUnknown.includes(x.id))return {criterion_id:x.id,status:'unresolved',value:null,explanation:'ТЕСТ: критерий пока не определён.',missing_information:['ТЕСТ: нужен проверенный источник с правилом, действовавшим на дату диалога.'],evidence:[],checked_ranges:[],na_reason:'',na_condition:''};
    return {criterion_id:x.id,status:'resolved',missing_information:[],na_condition:'',value:x.type==='flag'?(fixtureFlag?'yes':'no'):x.type==='scale'?Math.max(...x.scale.map(s=>s.value)):'yes',
      explanation:'СИНТЕТИЧЕСКИЙ ТЕСТОВЫЙ ОТВЕТ. Проверка экрана, не AI-оценка и не Ground Truth.',
      evidence:x.type==='flag'&&!fixtureFlag?[]:[{message_id:m.message_id,quote:m.text}],
      checked_ranges:[{from_message_id:c.transcript[0].message_id,to_message_id:c.transcript.at(-1).message_id,expected_action:'ТЕСТ: проверенный участок, не автоматическое доказательство пропуска.'}],na_reason:''};
  })}
})};
const {server,service,store}=await createApp({directory,provider,referenceText:'TEST ONLY',datasetUrl:'',devFile:join(directory,'no-dev.json'),
  config:{ready:false,provider:'TEST DOUBLE',model:'TEST DOUBLE — NOT AI',missing:['Только изолированный UI-тест; AI не подключён']}});
const old=await service.evaluate(conversation,checklist);
let appealed=await service.appeal(old.evaluation_id,{revision:old.revision,criterion_id:'01',comment:'ТЕСТ: проверить показ решения и источников.'});
const change=structuredClone(appealed.final_review.criteria[0]);change.value='no';change.explanation='ТЕСТ: искусственное решение для проверки истории; не экспертный вывод.';
await service.resolve(old.evaluation_id,{revision:appealed.revision,appeal_id:appealed.appeals[0].appeal_id,action:'change',reason:'ТЕСТ: демонстрация отдельного финального результата.',review:change});
const next=structuredClone(checklist);next.version=2;
next.instructions='ТЕСТ v2: общие инструкции заменены. Новый критерий оценивает наличие обязательного слова ТЕСТ в тексте оператора.';
next.criteria.push({id:'custom-text',name:'ТЕСТ: обязательное слово',section:'ТЕСТ',type:'boolean',allowed_values:['yes','no'],weight:5,allow_na:false,na_rule:'',instruction:'ТЕСТ: проверить слово ТЕСТ в тексте оператора.',scale:[]});
await store.write('checklists',[checklist,next]);
await service.evaluate(conversation,next);
fixtureUnknown=['04'];await service.evaluate({...conversation,conversation_id:'synthetic-partial-weighted'},next);
fixtureUnknown=['08'];await service.evaluate({...conversation,conversation_id:'synthetic-flag-unknown'},next);
fixtureUnknown=[];fixtureFlag=true;await service.evaluate({...conversation,conversation_id:'synthetic-confirmed-gross'},next);
server.listen(3002,'127.0.0.1',()=>console.log('SYNTHETIC OFFLINE UI TEST ONLY: http://127.0.0.1:3002'));
const close=()=>server.close(async()=>{
  const target=resolve(directory);
  if (dirname(target)===resolve(tmpdir()) && /^cqa-offline-ui-/.test(basename(target))) await rm(target,{recursive:true,force:true});
  process.exit(0);
});
process.on('SIGINT',close);process.on('SIGTERM',close);
