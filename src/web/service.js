// All workspace labels come from the existing controller state, without AI calls.
export function mountService(){
 const $=selector=>document.querySelector(selector);
 const status={completed:'Завершён',partial:'Частичный результат',failed:'Ошибка оценки',running:'Выполняется'};
 window.addEventListener('cqa:state',({detail:s})=>{
  $('#step-source').dataset.complete=String(s.active);
  $('#step-rules').dataset.complete=String(Boolean(s.criteria));
  $('#step-launch').dataset.running=String(s.running);
  $('#service-view').dataset.hasData=String(Boolean(s.count));
  $('#launch-dialogue').textContent=s.activeId||'Диалог не выбран';
  $('#launch-dialogue').title=s.activeId||'';
  $('#launch-checklist').textContent=s.criteria?`${s.criteria} критериев · версия ${s.version}`:'Чек-лист загружается';
  $('#service-session-state').textContent=s.running?'Проверка выполняется':s.evaluated?(status[s.evaluationStatus]||'Результат получен'):s.active?'Диалог выбран':'Выберите источник диалогов';
  $('#service-session-detail').textContent=s.active?[s.activeLanguage,s.activeChannel==='voice call'?'Звонок':'Чат',s.activeId].filter(Boolean).join(' · '):'JSON-файл или набор через API';
  $('#batch-summary-label').textContent=s.batch?`${({running:'Выполняется',paused:'На паузе',completed:'Завершён',interrupted:'Прерван'})[s.batch.status]||'Прогон'} · ${s.batch.finished} из ${s.batch.total}`:s.count?`${s.count} диалогов в загруженном наборе`:'Для всего загруженного набора';
 });
 window.dispatchEvent(new Event('cqa:request-state'));
}
