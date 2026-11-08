import {mountComponents} from './components.js';
mountComponents();
// Progressive UI enhancements. Core import/evaluation flows stay in app.js.
const $=selector=>document.querySelector(selector);
function renderView(){
 const hash=location.hash.slice(1),service=new URLSearchParams(location.search).get('embed')==='1'||['service','overview','workspace','import-panel','batch-panel','editor','history'].includes(hash);
 document.documentElement.dataset.view=service?'service':'landing';$('#landing-view').hidden=service;$('#service-view').hidden=!service;
 if(hash==='batch-panel')$('#batch-disclosure').open=true;
 if(hash==='editor'){$('#editor').hidden=false;$('#editor-toggle').setAttribute('aria-expanded','true');}
 requestAnimationFrame(()=>{if(!hash||hash==='home'||hash==='service')window.scrollTo({top:0,behavior:'instant'});else document.getElementById(hash)?.scrollIntoView({block:'start'});});
}
window.addEventListener('hashchange',renderView);renderView();
if(new URLSearchParams(location.search).get('embed')==='1')document.documentElement.dataset.embed='true';
const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
let motionOff=reduced.matches;
function applyMotion(){document.documentElement.dataset.motion=motionOff?'off':'on';window.dispatchEvent(new CustomEvent('cqa:motion',{detail:{off:motionOff}}));}
applyMotion();
reduced.addEventListener('change',e=>{motionOff=e.matches;applyMotion();});
function reveal(id){const el=$(id);el.hidden=false;el.scrollIntoView({behavior:motionOff?'auto':'smooth',block:'start'});}
$('#nav-checklist').onclick=()=>{if($('#editor').hidden)$('#editor-toggle').click();reveal('#editor');};
$('#editor-close').onclick=()=>{$('#editor').hidden=true;$('#editor-toggle').setAttribute('aria-expanded','false');$('#editor-toggle').focus();};
$('#history-close').onclick=()=>{$('#history').hidden=true;$('#history-toggle').setAttribute('aria-expanded','false');$('#history-toggle').focus();};
$('#editor-toggle').addEventListener('click',()=>queueMicrotask(()=>{if(!$('#editor').hidden)reveal('#editor');}));
$('#history-toggle').addEventListener('click',()=>queueMicrotask(()=>{if(!$('#history').hidden)reveal('#history');}));
const drop=$('#drop-zone');
for(const name of ['dragenter','dragover'])drop.addEventListener(name,e=>{e.preventDefault();if(!$('#file').disabled)drop.classList.add('drag-over');});
for(const name of ['dragleave','drop'])drop.addEventListener(name,e=>{e.preventDefault();drop.classList.remove('drag-over');});
drop.addEventListener('drop',e=>{if($('#file').disabled||!e.dataTransfer.files.length)return;const transfer=new DataTransfer();transfer.items.add(e.dataTransfer.files[0]);$('#file').files=transfer.files;$('#file').dispatchEvent(new Event('change',{bubbles:true}));});
function searchMessages(){const query=$('#message-search').value.trim().toLocaleLowerCase();let found=0,total=0;document.querySelectorAll('#transcript .message').forEach(el=>{total++;const matches=Boolean(query)&&el.querySelector('.message-text').textContent.toLocaleLowerCase().includes(query);found+=Number(matches);el.classList.toggle('search-match',matches);el.classList.toggle('search-dim',Boolean(query)&&!matches);});$('#search-count').textContent=query?`${found} из ${total}`:'';}
$('#message-search').addEventListener('input',searchMessages);
window.addEventListener('cqa:state',e=>{const s=e.detail;$('#stat-dialogues').textContent=s.count;$('#stat-channel').textContent=s.count?`${s.chats} чатов · ${s.calls} звонков`:'Набор не загружен';$('#stat-criteria').textContent=s.criteria??'-';$('#stat-version').textContent=s.version?`Версия ${s.version}`:'Загрузка чек-листа';$('#dataset-label').textContent=s.count?`Загружено: ${s.count}`:'Набор не загружен';$('#stat-score').textContent=s.score===null||s.score===undefined?'-':Number(s.score).toLocaleString('ru-RU',{maximumFractionDigits:2});$('#stat-score-label').textContent=s.evaluated?'Финальная оценка':'Нет результата';$('#message-search').disabled=!s.active;$('#model-status').dataset.ready=String(s.modelReady);$('#model-status').title=$('#model-status').textContent;$('#editor-toggle').setAttribute('aria-expanded',String(!$('#editor').hidden));$('#history-toggle').setAttribute('aria-expanded',String(!$('#history').hidden));searchMessages();});
