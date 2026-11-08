import {workflowState,appendNotice} from './ui-model.js';
import {mountHalftone} from './halftone.js';
import {mountPolish} from './polish.js';
import {mountService} from './service.js';

// Framework-neutral adaptations: preserve the interactions of the supplied
// components while the existing Node backend and HTML controller stay intact.
export function mountComponents(){
 queueMicrotask(()=>{mountPolish();mountService();});
 const $=s=>document.querySelector(s);
 $('#footer-checklist').onclick=()=>{location.hash='editor';};

 const notifications=$('#notification-panel'),trigger=$('#notifications-toggle'),list=$('#notification-list');
 let notices=[],expanded=false;
 function drawNotices(){
  const show=expanded?notices:notices.slice(0,3);list.replaceChildren();list.classList.toggle('expanded',expanded);
  if(!show.length){const p=document.createElement('p');p.className='hint';p.textContent='Пока нет событий.';list.append(p);}
  for(const item of show){
   const card=document.createElement('article');card.className='notification-card';
   const heading=document.createElement('strong');heading.textContent='Событие';
   const time=document.createElement('time');time.dateTime=new Date(item.time).toISOString();time.textContent=new Date(item.time).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
   const text=document.createElement('p');text.textContent=item.message;card.append(time,heading,text);list.append(card);
  }
  $('#notification-count').textContent=notices.length;trigger.setAttribute('aria-label',`События сеанса: ${notices.length}`);
  $('#notification-expand').textContent=expanded?'Свернуть':`Показать все (${notices.length})`;$('#notification-expand').setAttribute('aria-expanded',String(expanded));
 }
 function setNotifications(open,restore=false){notifications.hidden=!open;trigger.setAttribute('aria-expanded',String(open));if(restore)trigger.focus();}
 trigger.onclick=()=>setNotifications(notifications.hidden);
 $('#notifications-close').onclick=()=>setNotifications(false,true);
 $('#notification-expand').onclick=()=>{expanded=!expanded;drawNotices();};
 document.addEventListener('pointerdown',e=>{if(!notifications.hidden&&!notifications.contains(e.target)&&!trigger.contains(e.target))setNotifications(false);});
 notifications.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();setNotifications(false,true);}});
 window.addEventListener('cqa:notice',e=>{notices=appendNotice(notices,e.detail.message);drawNotices();});
 let priorRunning=false,folderKey='';
 window.addEventListener('cqa:state',e=>{
  const s=e.detail,workflow=workflowState(s);
  $('#pipeline-summary').textContent=workflow.summary;$('#pipeline-mode').textContent=workflow.mode;$('#pipeline-log').textContent=workflow.log;
  $('#workflow-panel').dataset.running=String(s.running);
  for(const stage of workflow.stages){$(`#pipeline-${stage.id}`).dataset.state=stage.state;$(`#pipeline-${stage.id}-state`).textContent=stage.label;}
  if(s.running&&!priorRunning){notices=appendNotice(notices,`Запущена оценка диалога ${s.activeId}.`);drawNotices();$('#workflow-panel').open=true;}
  if(!s.running&&priorRunning){notices=appendNotice(notices,'Запрос завершён.');drawNotices();}
  priorRunning=s.running;
  const key=JSON.stringify(s.files??[]);
  if(key!==folderKey){
   folderKey=key;$('#folder-tray').hidden=!s.count;$('#folder-meta').textContent=s.count?`В папке: ${s.count} · ${s.chats} чатов · ${s.calls} звонков`:'Один диалог или набор';
   $('#folder-conversations').replaceChildren();
   for(const file of s.files??[]){
    const b=document.createElement('button');b.type='button';b.className='folder-file';b.dataset.index=file.index;
    const name=document.createElement('span');name.textContent=file.id;
    const meta=document.createElement('small');meta.textContent=`${file.language} · ${file.channel==='voice call'?'Звонок':'Чат'}`;
    b.append(name,meta);b.onclick=()=>{const select=$('#conversation-select');select.value=String(file.index);select.dispatchEvent(new Event('change',{bubbles:true}));$('#workspace').scrollIntoView({block:'start'});};
    $('#folder-conversations').append(b);
   }
  }
  for(const file of $('#folder-conversations').children)file.setAttribute('aria-current',String(file.dataset.index===$('#conversation-select').value));
 });
 mountHalftone($('#halftone-footer'),$('#footer-dots'));
}
