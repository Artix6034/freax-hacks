// Supplement omitted from the first freeze: same-score controls for hypothesis 1.
// Frozen before their own calls, while the original baseline is running.
import {readFile,writeFile} from 'node:fs/promises';
import {normalizeConversation,hash} from '../../src/domain.js';
const base=JSON.parse(await readFile(new URL('./cases.frozen.json',import.meta.url),'utf8'));
const conditional={RU:'Если панель ещё закрыта, откройте её; затем нажмите «Сохранить».',KZ:'Панель әлі жабық болса, оны ашыңыз; содан кейін «Сақтау» батырмасын басыңыз.',EN:'If the panel is still closed, open it; then press Save.'};
const cases=[];
for(const lang of ['RU','KZ','EN'])for(const v of ['a','b']){
 const old=base.cases.find(c=>c.id===`h1-action-${lang}-${v}`),m=old.conversation.transcript;
 const conversation=normalizeConversation({...old.conversation,conversation_id:`novel-h1-invariant-${lang}-${v}`,transcript:[m[0],{...m[1],text:m[1].text.split(lang==='EN'?' Is ':lang==='KZ'?' «':' Панель')[0]+' '+conditional[lang]},m[4],m[5]]});
 cases.push({...old,id:`h1-invariant-${lang}-${v}`,split:'invariance',pair_id:`h1-invariant-${lang}`,changed_fact:'Only intended/already completed state; conditional next step accommodates both.',expected:{'06':{values:[10],reason:'Условный следующий шаг не требует повторно сообщать известное состояние.',disputed:false,preferred:null}},conversation});
}
const suite={created_at:new Date().toISOString(),notice:'Supplement frozen after baseline started, before supplemental calls and before candidate design. Not part of the initial global freeze; expectations never revised using outcomes.',cases};
await writeFile(new URL('./invariance.frozen.json',import.meta.url),JSON.stringify(suite,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,sha256:hash(suite)}));
