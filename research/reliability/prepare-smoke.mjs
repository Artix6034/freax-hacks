import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {importConversations} from '../../src/domain.js';
const all=importConversations(JSON.parse(await readFile('data/dev/api-response.json','utf8')));
const ids=['p1-ru-010','p1-kz-008','p1-en-013','p4-ru-001'];
const selected=ids.map(id=>{const c=all.find(c=>c.conversation_id===id);if(!c)throw Error('Missing source');return c;});
selected.push({conversation_id:'SYNTHETIC-role-schema-no-context',channel:'agent chat',language:'RU',audio_url:null,transcript:[
 {speaker:'client',timestamp:'00:00',text:'Здравствуйте! Повторите слово «маяк».'},
 {speaker:'operator',timestamp:'00:01',text:'Здравствуйте! Я Анна. Маяк. Если нужна помощь, обращайтесь. До свидания!'}]});
const directory=resolve('data/live-smoke/2026-11-07-source-roles');await mkdir(directory,{recursive:true});
await writeFile(join(directory,'dataset.json'),JSON.stringify(selected,null,2));
console.log(JSON.stringify({directory,real_dialogues:ids,synthetic_count:1,planned_calls:5,notice:'Functional source-schema smoke check, not a GT benchmark.'}));
