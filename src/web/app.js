import { renderEvidenceHTML, roleLabel } from './evidence.js';
const $ = s => document.querySelector(s);
let conversations = [], checklists = [], activeConversation = null, evaluation = null, modelReady = false, running = false;
let focusedRange = null;
let batchEnabled=false,batchRun=null,batchRefreshing=false;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const labelValue = v => v===null?'Не определено':({ yes:'Да', no:'Нет', na:'N/A' }[v] ?? v);
const statusLabel = v => ({completed:'Полный',partial:'Частичный',failed:'Сбой',running:'В работе'}[v] ?? v);
const reviewState = r => r?.criteria?.some(c=>c.status==='unresolved')?'partial':'completed';
const flagLabel = v => v===true?'Обнаружены грубые ошибки':v===false?'Грубые ошибки не выявлены':'Грубые ошибки: не определено';
const missingHTML = r => r?.status==='unresolved'?`<div class="missing-information"><strong>Не определено — чего не хватает:</strong><ul>${(r.missing_information??[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:'';
const fmt = v => v === null ? 'Не рассчитан' : Number(v).toLocaleString('ru-RU', { minimumFractionDigits:2, maximumFractionDigits:2 });
const selectedChecklist = () => checklists[Number($('#checklist-select').value)];
function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || 'Ошибка запроса.'); return result;
}
function updateLaunch() {
  $('#batch-start').disabled=!batchEnabled||!conversations.length||!modelReady||running||batchRun?.status==='running';
  $('#evaluate').disabled = running || !activeConversation || !modelReady;
  $('#run-state').textContent = running ? 'Модель анализирует переданный транскрипт…' : !modelReady ? 'Настройте модель на сервере и перезапустите сервис.' : !activeConversation ? 'Загрузите диалог для оценки.' : 'Будет выполнен новый запрос к модели. Заполненные настройки не подтверждают доступ.';
}
function renderTranscript(c) {
  activeConversation = c; focusedRange = null; updateLaunch();
  $('#transcript-selection').textContent = '';
  $('#context-start').disabled = true; $('#context-end').disabled = true;
  $('#conversation-meta').textContent = c ? `${c.language} · ${c.transcript.length} сообщений` : '';
  $('#audio').replaceChildren();
  if (c?.audio_url) { const a = document.createElement('a'); a.href = c.audio_url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Открыть запись звонка ↗'; $('#audio').append(a); }
  $('#transcript').innerHTML = c ? c.transcript.map(m => `<article id="msg-${esc(m.message_id)}" class="message ${esc(m.speaker)}"><div class="message-meta"><span>${esc(roleLabel(m.speaker))} · ${esc(m.message_id)}</span><time>${esc(m.timestamp)}</time></div><div class="message-text">${esc(m.text)}</div></article>`).join('') : '<p class="empty">Загрузите транскрипт.</p>';
}
function highlight(from, to = from) {
  document.querySelectorAll('.message.highlight, .message.context').forEach(el => el.classList.remove('highlight','context'));
  const messages = activeConversation.transcript;
  const first = messages.findIndex(m => m.message_id === from), last = messages.findIndex(m => m.message_id === to);
  if (first < 0 || last < first) return;
  focusedRange = {first,last};
  for (let i = first; i <= last; i++) document.getElementById(`msg-${messages[i].message_id}`)?.classList.add('highlight');
  for (const i of [first-1,last+1]) if (messages[i]) document.getElementById(`msg-${messages[i].message_id}`)?.classList.add('context');
  $('#transcript-selection').textContent = `Выделено: ${messages[first].timestamp} — ${messages[last].timestamp}. Соседние сообщения доступны рядом и в карточке источника.`;
  $('#context-start').disabled = false; $('#context-end').disabled = false;
  scrollContext('start');
}
function scrollContext(edge) {
  if (!focusedRange) return;
  const messages=activeConversation.transcript;
  const index=edge==='start'?Math.max(0,focusedRange.first-1):Math.min(messages.length-1,focusedRange.last+1);
  document.getElementById(`msg-${messages[index].message_id}`)?.scrollIntoView({behavior:'smooth',block:edge==='start'?'start':'end'});
}
function options(values, selected) { return values.map(v => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(labelValue(v))}</option>`).join(''); }
function messageOptions(selected) { return activeConversation.transcript.map(m => `<option value="${esc(m.message_id)}" ${m.message_id === selected ? 'selected' : ''}>${esc(m.message_id)} · ${esc(m.timestamp)} · ${esc(m.text.slice(0,65))}</option>`).join(''); }
function renderResult(r) {
  evaluation = r; $('#export').hidden = !r;
  if (!r) { $('#result').innerHTML = '<p class="empty">Запустите оценку выбранного диалога.</p>'; return; }
  renderTranscript(r.conversation);
  const checklistHeader = `<p class="result-checklist"><strong>${esc(r.checklist.name)} · версия ${esc(r.checklist.version)}</strong><br><span class="hint">Сохранённый снимок оценки · ${esc(r.checklist.checklist_id)}<br>Промпт: ${esc(r.prompt_version??r.ai_metadata?.prompt_version??'не сохранён')} · схема: ${esc(r.ai_metadata?.schema_version??'не сохранена')}<br>Прогон: ${esc(r.run_id??'отдельная оценка')} · конфигурация: ${esc(r.configuration_hash?.slice(0,12)??'старая запись')}<br>Модель: ${esc(r.ai_metadata?.model??'не определена')}</span></p><details><summary>Общие инструкции этой оценки</summary><p class="rules-text">${esc(r.checklist.instructions)}</p></details>`;
  if (!['completed','partial'].includes(r.status)) { $('#result').innerHTML = checklistHeader + `<div class="notice">${r.status === 'running' ? 'Оценка выполнялась. Если сервис был перезапущен, запустите новую оценку.' : esc(r.error)}</div><p class="hint">Статус: ${esc(r.status)}. Итог отсутствует.</p>`; return; }
  $('#result').innerHTML = checklistHeader + `<div class="score-banner"><div>Итоговая оценка</div><div class="score-value">${fmt(r.final_score.total)} <small>/ 100</small></div><span class="flag ${r.final_score.gross_error===true ? 'danger' : r.final_score.gross_error===null?'unknown':''}">${flagLabel(r.final_score.gross_error)}</span>${r.final_score.total_reason?`<p>${esc(r.final_score.total_reason)}</p>`:''}</div><p class="status-note">Исходный AI: ${statusLabel(r.ai_status??reviewState(r.ai_review))} · финальный: ${statusLabel(r.final_status??reviewState(r.final_review))}<br>Разобрано критериев: ${r.final_review.criteria.filter(c=>c.status!=='unresolved').length}/${r.final_review.criteria.length}<br>${esc(r.checklist.name)} · версия ${r.checklist.version}<br>Модель: ${esc(r.ai_metadata.model)} · ${esc(r.ai_metadata.provider)}<br>Исходный итог AI: ${fmt(r.original_score.total)} · исходный флаг: ${labelValue(r.original_score.gross_error===null?null:r.original_score.gross_error?'yes':'no')}<br>Итог рассчитывается без промежуточного округления. Если балльный критерий не определён, глобальные веса и полный итог не рассчитываются.</p>` + r.checklist.criteria.map((c, index) => {
    const review = r.final_review.criteria.find(x => x.criterion_id === c.id), score = r.final_score.criteria.find(x => x.criterion_id === c.id), original = r.ai_review.criteria.find(x => x.criterion_id === c.id);
    const appeals = r.appeals.filter(a => a.criterion_id === c.id);
    return `<article class="criterion-result" data-index="${index}"><h3><span>${esc(c.id)} · ${esc(c.name)}</span><span class="badge">${esc(labelValue(review.value))}</span></h3><p class="hint">${c.type === 'flag' ? 'Отдельный флаг, без баллов' : `Исходный вес ${fmt(c.weight)} · баллы до перераспределения: ${score.raw_points===undefined?fmt(score.normalized==null?null:score.normalized*c.weight):fmt(score.raw_points)}<br>${score.effective_weight===null?'Глобальные веса и вклад не рассчитаны до разрешения неопределённости':`Эффективный вес ${fmt(score.effective_weight)} · вклад ${fmt(score.contribution)}`}`}</p><p class="reason">${esc(review.explanation)}</p>${missingHTML(review)}${review.value === 'na' ? `<p class="reason"><strong>Причина N/A:</strong> ${esc(review.na_reason)}</p>` : ''}${renderEvidenceHTML(review,r.conversation)}<details><summary>Исходное решение AI</summary><p class="reason">${esc(labelValue(original.value))} · ${esc(original.explanation)}</p>${missingHTML(original)}${original.value==='na'?`<p class="reason">Причина N/A: ${esc(original.na_reason)}</p>`:''}${renderEvidenceHTML(original,r.conversation)}</details>${appeals.map(a => appealHTML(a, c, review)).join('')}${appeals.some(a => a.status === 'pending') ? '' : `<details><summary>Подать апелляцию</summary><form class="appeal-form"><label>Что нужно пересмотреть?<textarea name="comment" required rows="2"></textarea></label><button>Сохранить обращение</button></form></details>`}</article>`;
  }).join('') + `<details><summary>Вклад секций в общий итог</summary>${(r.final_score.sections ?? []).map(s => `<p class="hint">${esc(s.section)}: ${fmt(s.contribution)} из ${fmt(s.effective_weight)}</p>`).join('')}</details>`;
}
function appealHTML(a, c, review) {
  return `<div class="appeal"><strong>${a.status === 'pending' ? 'Ожидает проверки' : 'Решение сохранено'}</strong><p class="reason">${esc(a.comment)}</p><p class="hint">Оспариваемый ответ: ${esc(labelValue(a.disputed_review.value))}</p><details><summary>Источники оспариваемой оценки</summary><p class="reason">${esc(a.disputed_review.explanation)}</p>${missingHTML(a.disputed_review)}${renderEvidenceHTML(a.disputed_review,evaluation.conversation)}</details>${a.status === 'resolved' ? `<p class="reason">${a.action === 'confirm' ? 'Подтверждено' : 'Изменено'}: ${esc(a.reason)}</p><p>Ответ после решения: ${esc(labelValue(a.decision_review.value))}</p><p class="reason">${esc(a.decision_review.explanation)}</p>${missingHTML(a.decision_review)}${a.decision_review.value==='na'?`<p class="reason">Причина N/A: ${esc(a.decision_review.na_reason)}</p>`:''}${renderEvidenceHTML(a.decision_review,evaluation.conversation)}` : `<details><summary>Рассмотреть апелляцию</summary><form class="resolve-form" data-appeal="${esc(a.appeal_id)}"><label>Действие<select name="action"><option value="confirm">Подтвердить оценку</option><option value="change">Изменить оценку</option></select></label><label>Ответ<select name="value"><option value="__unresolved" ${review.status==='unresolved'?'selected':''}>Не определено</option>${options(c.allowed_values.filter(v=>v!=='na'||!c.na_channels||c.na_channels.includes(activeConversation.channel)), review.value)}</select></label><label>Чего не хватает (если ответ не определён, по одному пункту на строку)<textarea name="missing_information" rows="2">${esc((review.missing_information??[]).join('\n'))}</textarea></label>${c.na_condition?`<label><input type="checkbox" name="na_condition" ${review.na_condition===c.na_condition?'checked':''}> Подтверждено условие N/A: ${esc(c.na_rule)}</label>`:''}<label>Причина решения<textarea name="reason" required rows="2"></textarea></label><label>Обоснование новой оценки<textarea name="explanation" rows="2">${esc(review.explanation)}</textarea></label><label>Причина N/A (если выбрано)<textarea name="na_reason" rows="2">${esc(review.na_reason)}</textarea></label><div class="row"><label>Начало проверенного участка<select name="from">${messageOptions(activeConversation.transcript[0].message_id)}</select></label><label>Конец участка<select name="to">${messageOptions(activeConversation.transcript.at(-1).message_id)}</select></label></div><label>Какое действие проверено?<input name="expected_action" value="${esc(c.name)}"></label><label>Сообщение-доказательство<select name="evidence_message">${messageOptions(review.evidence[0]?.message_id || activeConversation.transcript.find(m=>m.speaker==='operator').message_id)}</select></label><label>Точная цитата (обязательна для положительного ответа)<textarea name="quote" rows="2">${esc(review.evidence[0]?.quote || '')}</textarea></label><button>Сохранить решение проверяющего</button></form></details>`}</div>`;
}
function renderSelectedRules(c) {
  $('#selected-instructions').textContent = c.instructions;
  $('#selected-rule-version').textContent = `Общие инструкции · версия ${c.version}`;
}
function renderEditor(c) {
  $('#checklist-name').value = c.name; $('#checklist-instructions').value = c.instructions;
  $('#criteria-editor').innerHTML = c.criteria.map((x, i) => `<details class="criterion-editor" data-id="${esc(x.id)}" open><summary>${esc(x.id)} · ${esc(x.name)}</summary><div class="row"><label>Название<input name="name" value="${esc(x.name)}"></label><label>Секция<input name="section" value="${esc(x.section)}"></label></div><div class="row"><label>Тип ответа<select name="type">${['boolean','scale','flag'].map(t => `<option value="${t}" ${x.type===t?'selected':''}>${{boolean:'Да / Нет',scale:'Числовая шкала',flag:'Отдельный флаг'}[t]}</option>`).join('')}</select></label><label>Вес<input name="weight" type="number" min="0" max="10000" step="0.001" value="${x.weight}"></label><label><input name="allow_na" type="checkbox" ${x.allow_na?'checked':''}> Разрешить N/A</label></div><label>Инструкция<textarea name="instruction" rows="3">${esc(x.instruction)}</textarea></label><label>Условие N/A<textarea name="na_rule" rows="2">${esc(x.na_rule)}</textarea></label><label>Каналы, где допускается N/A<select name="na_channels"><option value="all">Все каналы</option><option value="voice call" ${x.na_channels?.length===1&&x.na_channels[0]==='voice call'?'selected':''}>Только звонки</option><option value="agent chat" ${x.na_channels?.length===1&&x.na_channels[0]==='agent chat'?'selected':''}>Только чаты</option></select></label><label>Ступени числовой шкалы — каждая с новой строки: число | описание<textarea name="scale" rows="${Math.max(2,x.scale.length)}">${esc(x.scale.map(s => `${s.value} | ${s.description}`).join('\n'))}</textarea></label><div class="row"><label>Роли доказательств для положительного ответа (через запятую)<input name="positive_roles" value="${esc((x.evidence_policy?.positive_roles || ['operator']).join(','))}"></label><label>Область положительного доказательства<select name="positive_scope"><option value="any">Любая подходящая реплика</option><option value="first_operator" ${x.evidence_policy?.positive_scope==='first_operator'?'selected':''}>Первый ответ оператора</option></select></label></div><button type="button" class="danger-button remove-criterion">Удалить критерий</button></details>`).join('');
}
function collectChecklist() {
  const base = structuredClone(selectedChecklist()); base.name = $('#checklist-name').value; base.instructions = $('#checklist-instructions').value;
  base.criteria = [...document.querySelectorAll('.criterion-editor')].map(el => {
    const val = n => el.querySelector(`[name="${n}"]`).value;
    const type = val('type'), allow_na = el.querySelector('[name="allow_na"]').checked;
    const scale = type === 'scale' ? val('scale').split('\n').filter(s => s.trim()).map(line => {
      const separator = line.indexOf('|'); if (separator < 0) throw Error('Ступень шкалы: число | описание.');
      return { value:Number(line.slice(0,separator).trim()), description:line.slice(separator+1).trim() };
    }) : [];
    const prior=selectedChecklist().criteria.find(c=>c.id===el.dataset.id);
    return { ...(allow_na && val('na_channels')!=='all'?{na_channels:[val('na_channels')]}:{}),...(allow_na && prior?.na_condition?{na_condition:prior.na_condition}:{}), id:el.dataset.id, name:val('name'), section:val('section'), type, weight:Number(val('weight')), allow_na, na_rule:val('na_rule'), instruction:val('instruction'), scale, evidence_policy:{positive_roles:val('positive_roles').split(',').map(s=>s.trim()).filter(Boolean),positive_scope:val('positive_scope')},
      allowed_values:[...(type === 'scale' ? scale.map(s => s.value) : ['yes','no']), ...(allow_na ? ['na'] : [])] };
  }); return base;
}
async function loadChecklists(selectLatest = true) {
  checklists = await api('/api/checklists');
  $('#checklist-select').innerHTML = checklists.map((c,i) => `<option value="${i}">${esc(c.name)} · v${c.version}</option>`).join('');
  if (selectLatest) $('#checklist-select').value = String(checklists.length-1);
  renderSelectedRules(selectedChecklist()); renderEditor(selectedChecklist());
}
function useConversations(records) {
  conversations = records;
  $('#conversation-select').innerHTML = conversations.map((c,i) => `<option value="${i}">${esc(c.conversation_id)} · ${c.language}</option>`).join(''); $('#conversation-select').disabled = false;
  const pilotIndex=conversations.findIndex(c=>c.conversation_id==='p1-ru-010');
  const index=pilotIndex<0?0:pilotIndex;
  $('#conversation-select').value=String(index);
  renderResult(null); renderTranscript(conversations[index]);
}
$('#file').addEventListener('change', async e => { try {
  notice(); const file = e.target.files[0]; if (!file) return;
  if (file.size > 8*1024*1024) throw Error('Файл больше 8 МБ.');
  const data = await api('/api/import', JSON.parse(await file.text())); useConversations(data.conversations);
} catch(e) { notice(e.message); } });
for (const [id,path] of [['local-dev','local-dev'],['remote-import','import']]) {
  $(`#${id}`).onclick=async()=>{ const b=$(`#${id}`); b.disabled=true; notice(); try {
    const data=await api(`/api/datasets/${path}`,path==='import'?{group_id:$('#group-id').value.trim()}:{});
    useConversations(data.conversations); notice(`Загружено диалогов: ${data.conversations.length}. Оценка ещё не запускалась.`);
  } catch(e) {notice(e.message);} finally {b.disabled=false;} };
}
$('#conversation-select').addEventListener('change', () => { renderResult(null); renderTranscript(conversations[Number($('#conversation-select').value)]); });
$('#editor-toggle').onclick = () => { $('#editor').hidden = !$('#editor').hidden; };
$('#checklist-select').onchange = () => { renderSelectedRules(selectedChecklist()); renderEditor(selectedChecklist()); };
$('#criteria-editor').onclick = e => { if(e.target.closest('.remove-criterion')) e.target.closest('.criterion-editor').remove(); };
$('#add-criterion').onclick = () => { try { const c = collectChecklist(); c.criteria.push({id:`custom-${Date.now()}`, name:'Новый критерий', section:'', type:'boolean', weight:5, allow_na:false, na_rule:'', instruction:'Опишите условия ответа Да и Нет.', scale:[], allowed_values:['yes','no']}); renderEditor(c); } catch(e) { notice(e.message); } };
$('#save-checklist').onclick = async () => { try { const c = await api('/api/checklists', collectChecklist()); await loadChecklists(); notice(`Чек-лист сохранён: версия ${c.version}. Для применения запустите новую оценку.`); } catch(e) { notice(e.message); } };
$('#evaluate').onclick = async () => { running = true; updateLaunch(); notice(); try {
  const c = selectedChecklist();
  const r = await api('/api/evaluations', { conversation:activeConversation, checklist_id:c.checklist_id, checklist_version:c.version });
  renderResult(r); if (r.status === 'failed') notice(r.error);
} catch(e) { notice(e.message); } finally { running = false; updateLaunch(); } };
$('#context-start').onclick = () => scrollContext('start');
$('#context-end').onclick = () => scrollContext('end');
$('#result').addEventListener('click', e => { const button = e.target.closest('[data-from]'); if(button) highlight(button.dataset.from, button.dataset.to); });
$('#result').addEventListener('submit', async e => {
  e.preventDefault(); const form = e.target, index = Number(form.closest('[data-index]').dataset.index), criterion = evaluation.checklist.criteria[index];
  const data = new FormData(form); const button = form.querySelector('button'); button.disabled = true;
  try {
    let r;
    if (form.matches('.appeal-form')) r = await api(`/api/evaluations/${evaluation.evaluation_id}/appeals`, { revision:evaluation.revision, criterion_id:criterion.id, comment:data.get('comment') });
    else {
      const raw = data.get('value'), unresolved=raw==='__unresolved', value=unresolved?null:criterion.allowed_values.find(v => String(v) === raw);
      r = await api(`/api/evaluations/${evaluation.evaluation_id}/resolve`, { revision:evaluation.revision, appeal_id:form.dataset.appeal, action:data.get('action'), reason:data.get('reason'), review:{
        criterion_id:criterion.id, value, status:unresolved?'unresolved':'resolved', missing_information:unresolved?data.get('missing_information').split('\n').map(s=>s.trim()).filter(Boolean):[],na_condition:value==='na'&&data.get('na_condition')?criterion.na_condition:'', explanation:data.get('explanation'), na_reason:value==='na'?data.get('na_reason'):'', evidence:data.get('quote').trim() ? [{message_id:data.get('evidence_message'),quote:data.get('quote')}] : [],
        checked_ranges:[{from_message_id:data.get('from'),to_message_id:data.get('to'),expected_action:data.get('expected_action')}]
      }});
    }
    notice(); renderResult(r);
  } catch(err) { notice(err.message); button.disabled = false; }
});
async function loadHistory() {
  const params=new URLSearchParams();
  for(const key of ['view','gross_error','conversation_id','status','checklist_version']) {
    const value=$(`#history-${key}`).value; if(value)params.set(key,value);
  }
  const records=await api(`/api/evaluations?${params}`);
  $('#history-list').innerHTML=records.length?records.map(r=>`<button class="history-item" data-id="${r.evaluation_id}"><strong>${esc(r.conversation_id)}</strong> · ${esc(r.checklist_name||r.checklist_id||'Чек-лист')} · ${r.checklist_version==null?'версия неизвестна':`версия ${esc(r.checklist_version)}`}<br>${r.view==='original'?'Исходный AI':'Финальная версия'} · ${statusLabel(r.status)} · итог ${fmt(r.total)} · ${flagLabel(r.gross_error)}<br><span class="hint">AI: ${statusLabel(r.ai_status)} · финальный: ${statusLabel(r.final_status)}${r.human_reviewed?' · есть ручной пересмотр':''} · ${esc(new Date(r.created_at).toLocaleString())}</span></button>`).join(''):'<p class="hint">По выбранным фильтрам оценок нет.</p>';
}
$('#history-toggle').onclick=async()=>{ $('#history').hidden=!$('#history').hidden;if(!$('#history').hidden)try{await loadHistory();}catch(e){notice(e.message);} };
$('#history-filters').onsubmit=async e=>{e.preventDefault();try{await loadHistory();}catch(err){notice(err.message);}};
for(const id of ['view','gross_error','status'])$(`#history-${id}`).onchange=async()=>{try{await loadHistory();}catch(e){notice(e.message);}};
$('#organizer-update').onclick=async()=>{try{
  const c=await api('/api/checklists/organizer-update',{});await loadChecklists();
  $('#checklist-select').value=String(checklists.findIndex(x=>x.checklist_id===c.checklist_id&&x.version===c.version));
  renderSelectedRules(c);renderEditor(c);notice(`Выбрана версия ${c.version} с уточнениями организатора на основе v1. Пользовательские версии и старые оценки сохранены. Для применения запустите новую оценку.`);
}catch(e){notice(e.message);}};
$('#history-list').onclick = async e => { const b = e.target.closest('[data-id]'); if (!b) return; try { renderResult(await api(`/api/evaluations/${b.dataset.id}`)); } catch(e) { notice(e.message); } };
$('#export').onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(evaluation,null,2)], {type:'application/json'})); const a = document.createElement('a'); a.href=url; a.download=`cqa-${evaluation.evaluation_id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); };
function renderBatch(run){
  batchRun=run;
  $('#batch-progress').innerHTML=run?`<p><strong>${esc(({pending:'Ожидает запуска',running:'Выполняется',paused:'На паузе',completed:'Обработка завершена',interrupted:'Прерван'})[run.status]??run.status)}</strong> · обработано ${run.finished}/${run.total}</p><progress max="${run.total}" value="${run.finished}"></progress><p>Полных: ${run.counts.completed} · частичных: ${run.counts.partial} · сбоев: ${run.counts.failed} · осталось: ${run.counts.pending+run.counts.running}</p><p>Модель: ${esc(run.execution.requested_model)}<br>Промпт: ${esc(run.execution.prompt_version)} · схема: ${esc(run.execution.schema_version)}<br>Чек-лист: ${esc(run.execution.checklist_id)} · версия ${run.execution.checklist_version}<br>Прогон: ${esc(run.run_id)}</p>`:'Прогонов пока нет.';
  $('#batch-pause').disabled=!run||run.status!=='running';
  $('#batch-resume').disabled=!run||!(run.counts.pending+run.counts.running);
  $('#batch-retry').disabled=!run||!run.counts.failed||run.status==='running';
  $('#batch-export').disabled=!run||run.finished!==run.total;
  updateLaunch();
}
async function refreshRuns(preferred){
  if(!batchEnabled||batchRefreshing)return;batchRefreshing=true;
  try{
    const id=preferred??$('#batch-select').value,runs=await api('/api/runs');
    $('#batch-select').innerHTML=runs.length?runs.map(r=>`<option value="${esc(r.run_id)}">${esc(r.subset.toUpperCase())} · ${r.finished}/${r.total} · ${esc(r.execution.requested_model)} · ${esc(r.run_id.slice(0,8))}</option>`).join(''):'<option value="">Прогонов пока нет</option>';
    const selected=runs.find(r=>r.run_id===id)??runs[0]??null;if(selected)$('#batch-select').value=selected.run_id;renderBatch(selected);if(selected?.error)notice(selected.error);
  }finally{batchRefreshing=false;}
}
$('#batch-refresh').onclick=async()=>{try{await refreshRuns();}catch(e){notice(e.message);}};
$('#batch-select').onchange=async()=>{try{renderBatch(await api(`/api/runs/${$('#batch-select').value}`));}catch(e){notice(e.message);}};
$('#batch-start').onclick=async()=>{
  const button=$('#batch-start');button.disabled=true;
  try{notice();const c=selectedChecklist(),run=await api('/api/runs',{conversations,checklist_id:c.checklist_id,checklist_version:c.version,subset:$('#batch-subset').value,concurrency:Number($('#batch-concurrency').value)});await refreshRuns(run.run_id);}
  catch(e){notice(e.message);}finally{updateLaunch();}
};
for(const [id,action,retry] of [['batch-pause','pause',false],['batch-resume','resume',false],['batch-retry','resume',true]]){
  $(`#${id}`).onclick=async()=>{try{notice();await api(`/api/runs/${batchRun.run_id}/${action}`,{retry_failed:retry});if(action==='pause')notice('Пауза запрошена. Текущие оценки завершатся, затем очередь остановится.');await refreshRuns();}catch(e){notice(e.message);}};
}
$('#batch-export').onclick=async()=>{
  try{notice();const document=await api(`/api/runs/${batchRun.run_id}/submission`),url=URL.createObjectURL(new Blob([JSON.stringify(document,null,2)],{type:'application/json'})),a=window.document.createElement('a');a.href=url;a.download='results.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  catch(e){notice(e.message);}
};
try {
  const status = await api('/api/status'); modelReady = status.ready;
  $('#local-dev').hidden=!status.local_dev_ready;
  $('#dataset-status').textContent=status.dataset_ready?'API набора настроен на сервере.':'Для загрузки через API задайте CQA_DATASET_URL на сервере.';
  $('#model-status').textContent = status.ready ? `${status.model} · промпт ${status.prompt_version??'старая версия сервиса'} · схема ${status.schema_version??'не указана'} · доступ не проверен` : 'AI не настроен';
  batchEnabled=Boolean(status.batch_supported);$('#batch-panel').hidden=!batchEnabled;
  if (!status.ready) notice(`Для реальной AI-оценки заполните .env на сервере: ${status.missing.join(', ')}. Затем перезапустите приложение. Тестовые оценки не подставляются.`);
  await loadChecklists(); updateLaunch();
  if(batchEnabled){await refreshRuns();setInterval(()=>{if(!document.hidden)refreshRuns().catch(()=>{});},3000);}
} catch(e) { notice(e.message); }
