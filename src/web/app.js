import { renderEvidenceHTML, roleLabel } from './evidence.js';
import { submissionCompatibility } from './submission-compatibility.js';
import { connectEmbed } from './embed.js';
const $ = s => document.querySelector(s);
let conversations = [], checklists = [], activeConversation = null, evaluation = null, modelReady = false, running = false;
let focusedRange = null;
let batchEnabled=false,batchRun=null,batchRefreshing=false;
let currentView='review', languageFilter='all', knownEvaluations=new Map(), serviceStatus=null;
let notifyParent=()=>{};
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const labelValue = v => v===null?'Не определено':({ yes:'Да', no:'Нет', na:'N/A' }[v] ?? v);
const statusLabel = v => ({completed:'Полный',partial:'Частичный',failed:'Сбой',running:'В работе'}[v] ?? v);
const reviewState = r => r?.criteria?.some(c=>c.status==='unresolved')?'partial':'completed';
const flagLabel = v => v===true?'Обнаружены грубые ошибки':v===false?'Грубые ошибки не выявлены':'Грубые ошибки: не определено';
const missingHTML = r => r?.status==='unresolved'?`<div class="missing-information"><strong>Не определено — чего не хватает:</strong><ul>${(r.missing_information??[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:'';
const fmt = v => v === null ? 'Не рассчитан' : Number(v).toLocaleString('ru-RU', { minimumFractionDigits:2, maximumFractionDigits:2 });
const selectedChecklist = () => checklists[Number($('#checklist-select').value)];
let compatibilityKey=null;
function compatibilityHTML(c){
  const report=submissionCompatibility(c);
  if(report.compatible)return '';
  const descriptions={CRITERIA_REQUIRED:'Добавьте критерии.',CRITERION_SET:'Для сдачи нужны критерии 01–08.',TYPE:'Проверьте тип ответа.',SCALE:'Для сдачи нужна исходная шкала.'};
  return '<p>Эту версию нельзя выгрузить для сдачи.</p><ul>'+report.issues.map(i=>'<li>'+esc((i.criterion_id?i.criterion_id+': ':'')+(descriptions[i.code]??'Проверьте настройки критерия.'))+'</li>').join('')+'</ul>';
}
function refreshCompatibility(){
  const c=selectedChecklist(),key=JSON.stringify(c??null);
  if(key!==compatibilityKey){$('#allow-incompatible').checked=false;compatibilityKey=key;}
  $('#selected-compatibility').innerHTML=compatibilityHTML(c);
  $('#compatibility-consent').hidden=submissionCompatibility(c).compatible;
  $('#submission-check').hidden=submissionCompatibility(c).compatible;
}
function mayEvaluate(){return submissionCompatibility(selectedChecklist()).compatible||$('#allow-incompatible').checked;}
function requireEvaluationConsent(){if(!mayEvaluate())throw Error('Разрешите оценку без выгрузки в меню «Выгрузка недоступна».');}
function refreshDraftCompatibility(){
  const target=$('#draft-compatibility');
  try{target.innerHTML=compatibilityHTML(collectChecklist());target.hidden=!target.innerHTML;}
  catch(e){target.textContent=e.message;target.hidden=false;}
}
function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
function showView(view){
  currentView=view;
  for(const [name,id] of [['review','review-view'],['history','history'],['editor','editor'],['batch','batch-panel']])$(`#${id}`).hidden=name!==view;
  const titles={review:'Диалоги',history:'История оценок',editor:'Чек-листы',batch:'Пакетная проверка'};
  $('#view-title').textContent=titles[view];
  for(const [name,id] of [['review','nav-review'],['history','history-toggle'],['editor','editor-toggle'],['batch','nav-batch']]){
    const el=$(`#${id}`);el.classList.toggle('active',name===view);el.setAttribute('aria-label',titles[name]);
    if(name===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');
  }
}
function mobileTab(tab){document.body.dataset.mobileTab=tab;for(const name of ['transcript','result']){$(`#tab-${name}`).classList.toggle('selected',name===tab);$(`#tab-${name}`).setAttribute('aria-pressed',String(name===tab));}}
function renderConversationList(){
  $('#conversation-count').textContent=String(conversations.length);
  if(!conversations.length)return;
  const search=$('#conversation-search').value.toLowerCase().trim(),version=selectedChecklist()?.version;
  const rows=conversations.map((c,index)=>({c,index})).filter(({c})=>(languageFilter==='all'||c.language===languageFilter)&&(!search||`${c.conversation_id} ${c.transcript.filter(m=>m.speaker==='client').map(m=>m.text).join(' ')}`.toLowerCase().includes(search)));
  $('#conversation-list').innerHTML=rows.length?rows.map(({c,index})=>{
    const saved=knownEvaluations.get(`${c.conversation_id}:${version}`),preview=c.transcript.find(m=>m.speaker==='client'&&m.text.length>8)?.text??c.transcript.find(m=>m.speaker==='client')?.text??'Диалог';
    return `<button class="conversation-row ${activeConversation?.conversation_id===c.conversation_id?'selected':''}" data-conversation="${index}" aria-pressed="${activeConversation?.conversation_id===c.conversation_id}"><span class="list-top"><span class="list-id">${esc(c.conversation_id)}</span><span class="language-tag">${c.language}</span></span><span class="list-preview">${esc(preview)}</span><span class="list-status ${esc(saved?.status??'')}">${saved?`${statusLabel(saved.status)}${saved.total!=null?' · '+fmt(saved.total):''}`:'Не оценён'}</span></button>`;
  }).join(''):'<p class="empty">Диалоги не найдены. Измените поиск или язык.</p>';
}
async function openConversation(index){
  const c=conversations[index];if(!c)return;
  $('#conversation-select').value=String(index);renderResult(null);renderTranscript(c);renderConversationList();
  const selectedVersion=selectedChecklist()?.version;const saved=knownEvaluations.get(`${c.conversation_id}:${selectedVersion}`);
  if(saved){const r=await api(`/api/evaluations/${saved.evaluation_id}`);if(selectedChecklist()?.version===selectedVersion&&activeConversation?.conversation_id===c.conversation_id&&JSON.stringify(c.transcript)===JSON.stringify(r.conversation.transcript))renderResult(r);}
}
async function hydrateSavedAssessments(){
  const records=await api('/api/evaluations?view=final');knownEvaluations=new Map();
  for(const r of records){const key=`${r.conversation_id}:${r.checklist_version}`;if(!knownEvaluations.has(key))knownEvaluations.set(key,r);}
  renderConversationList();
}
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || 'Ошибка запроса.'); return result;
}
function updateLaunch() {
  refreshCompatibility();
  $('#batch-start').disabled=!batchEnabled||!conversations.length||!modelReady||running||batchRun?.status==='running'||!mayEvaluate();
  $('#evaluate').disabled = running || !activeConversation || !modelReady ||!mayEvaluate();
  $('#run-state').textContent = running ? 'Оцениваем…' : !modelReady ? 'Оценка недоступна' : '';
  $('#run-state').hidden=!$('#run-state').textContent;
  $('#evaluate').querySelector('span').textContent=running?'Идёт оценка…':'Оценить диалог';
}
function renderTranscript(c) {
  activeConversation = c; focusedRange = null; updateLaunch();
  $('#transcript-selection').textContent = '';
  $('#context-start').disabled = true; $('#context-end').disabled = true;
  $('#conversation-meta').textContent = c ? `${c.language} · ${c.transcript.length} сообщений` : '';
  $('#active-dialogue-title').textContent=c?.conversation_id??'Выберите диалог';
  $('#channel-label').textContent=c?(c.channel==='voice call'?'Звонок':'Чат'):'Рабочая область';
  $('#audio').replaceChildren();
  if (c?.audio_url) { const a = document.createElement('a'); a.href = c.audio_url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Открыть запись звонка ↗'; $('#audio').append(a); }
  $('#transcript').innerHTML = c ? c.transcript.map(m => `<article id="msg-${esc(m.message_id)}" class="message ${esc(m.speaker)}"><div class="message-meta"><span>${esc(roleLabel(m.speaker))} · ${esc(m.message_id)}</span><time title="${esc(m.timestamp)}">${esc(m.timestamp.includes('T')?m.timestamp.slice(11,19):m.timestamp)}</time></div><div class="message-text">${esc(m.text)}</div></article>`).join('') : '<p class="empty">Загрузите транскрипт.</p>';
}
function highlight(from, to = from) {
  mobileTab('transcript');
  document.querySelectorAll('.message.highlight, .message.context').forEach(el => el.classList.remove('highlight','context'));
  const messages = activeConversation.transcript;
  const first = messages.findIndex(m => m.message_id === from), last = messages.findIndex(m => m.message_id === to);
  if (first < 0 || last < first) return;
  focusedRange = {first,last};
  for (let i = first; i <= last; i++) document.getElementById(`msg-${messages[i].message_id}`)?.classList.add('highlight');
  for (const i of [first-1,last+1]) if (messages[i]) document.getElementById(`msg-${messages[i].message_id}`)?.classList.add('context');
  $('#transcript-selection').textContent = `${messages[first].timestamp} — ${messages[last].timestamp}`;
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
  if(r&&['completed','partial'].includes(r.status))notifyParent(r);
  if (!r) { $('#result').innerHTML = `<div class="workspace-empty"><h3>Оценка ещё не выполнена</h3></div>`; return; }
  renderTranscript(r.conversation);
  const checklistHeader = '<p class="result-checklist">'+esc(r.checklist.name)+' · v'+esc(r.checklist.version)+'</p>';
  if (!['completed','partial'].includes(r.status)) { $('#result').innerHTML = checklistHeader + '<div class="notice">'+(r.status==='running'?'Оценка выполняется…':esc(r.error||'Не удалось оценить диалог. Повторите попытку.'))+'</div>'; return; }
  $('#result').innerHTML = checklistHeader + `<div class="score-banner"><div>Итоговая оценка</div><div class="score-value">${fmt(r.final_score.total)} <small>/ 100</small></div><span class="flag ${r.final_score.gross_error===true?'danger':r.final_score.gross_error===null?'unknown':''}">${flagLabel(r.final_score.gross_error)}</span>${r.final_score.total_reason?'<p>'+esc(r.final_score.total_reason)+'</p>':''}</div>${r.status==='partial'?'<p class="status-note">Оценено критериев: '+r.final_review.criteria.filter(c=>c.status!=='unresolved').length+' из '+r.final_review.criteria.length+'</p>':''}` + r.checklist.criteria.map((c, index) => {
    const review = r.final_review.criteria.find(x => x.criterion_id === c.id), score = r.final_score.criteria.find(x => x.criterion_id === c.id), original = r.ai_review.criteria.find(x => x.criterion_id === c.id);
    const appeals = r.appeals.filter(a => a.criterion_id === c.id);
    return `<article class="criterion-result" data-index="${index}"><h3><span>${esc(c.id)} · ${esc(c.name)}</span><span class="badge ${review.status==='unresolved'?'is-unresolved':review.value==='no'?'is-no':review.value==='na'?'is-na':''}">${esc(labelValue(review.value))}</span></h3>${c.type!=='flag'&&score.contribution!=null?`<p class="hint">Вклад в итог: ${fmt(score.contribution)}</p>`:''}<p class="reason">${esc(review.explanation)}</p>${missingHTML(review)}${review.value === 'na' ? `<p class="reason"><strong>Причина N/A:</strong> ${esc(review.na_reason)}</p>` : ''}${renderEvidenceHTML(review,r.conversation)}<details><summary>Исходная оценка</summary><p class="reason">${esc(labelValue(original.value))} · ${esc(original.explanation)}</p>${missingHTML(original)}${original.value==='na'?`<p class="reason">Причина N/A: ${esc(original.na_reason)}</p>`:''}${renderEvidenceHTML(original,r.conversation)}</details>${appeals.map(a => appealHTML(a, c, review)).join('')}${appeals.some(a => a.status === 'pending') ? '' : `<details><summary>Подать апелляцию</summary><form class="appeal-form"><label>Что нужно пересмотреть?<textarea name="comment" required rows="2"></textarea></label><button>Сохранить обращение</button></form></details>`}</article>`;
  }).join('') + `<details><summary>Баллы по разделам</summary>${(r.final_score.sections ?? []).map(s => `<p class="hint">${esc(s.section)}: ${fmt(s.contribution)} из ${fmt(s.effective_weight)}</p>`).join('')}</details>`;
}
function appealHTML(a, c, review) {
  return `<div class="appeal"><strong>${a.status === 'pending' ? 'Ожидает проверки' : 'Решение сохранено'}</strong><p class="reason">${esc(a.comment)}</p><p class="hint">Оспариваемый ответ: ${esc(labelValue(a.disputed_review.value))}</p><details><summary>Источники оспариваемой оценки</summary><p class="reason">${esc(a.disputed_review.explanation)}</p>${missingHTML(a.disputed_review)}${renderEvidenceHTML(a.disputed_review,evaluation.conversation)}</details>${a.status === 'resolved' ? `<p class="reason">${a.action === 'confirm' ? 'Подтверждено' : 'Изменено'}: ${esc(a.reason)}</p><p>Ответ после решения: ${esc(labelValue(a.decision_review.value))}</p><p class="reason">${esc(a.decision_review.explanation)}</p>${missingHTML(a.decision_review)}${a.decision_review.value==='na'?`<p class="reason">Причина N/A: ${esc(a.decision_review.na_reason)}</p>`:''}${renderEvidenceHTML(a.decision_review,evaluation.conversation)}` : `<details><summary>Рассмотреть апелляцию</summary><form class="resolve-form" data-appeal="${esc(a.appeal_id)}"><label>Действие<select name="action"><option value="confirm">Подтвердить оценку</option><option value="change">Изменить оценку</option></select></label><label>Ответ<select name="value"><option value="__unresolved" ${review.status==='unresolved'?'selected':''}>Не определено</option>${options(c.allowed_values.filter(v=>v!=='na'||!c.na_channels||c.na_channels.includes(activeConversation.channel)), review.value)}</select></label><label>Чего не хватает (если ответ не определён, по одному пункту на строку)<textarea name="missing_information" rows="2">${esc((review.missing_information??[]).join('\n'))}</textarea></label>${c.na_condition?`<label><input type="checkbox" name="na_condition" ${review.na_condition===c.na_condition?'checked':''}> Подтверждено условие N/A: ${esc(c.na_rule)}</label>`:''}<label>Причина решения<textarea name="reason" required rows="2"></textarea></label><label>Обоснование новой оценки<textarea name="explanation" rows="2">${esc(review.explanation)}</textarea></label><label>Причина N/A (если выбрано)<textarea name="na_reason" rows="2">${esc(review.na_reason)}</textarea></label><div class="row"><label>Начало проверенного участка<select name="from">${messageOptions(activeConversation.transcript[0].message_id)}</select></label><label>Конец участка<select name="to">${messageOptions(activeConversation.transcript.at(-1).message_id)}</select></label></div><label>Какое действие проверено?<input name="expected_action" value="${esc(c.name)}"></label><label>Сообщение-доказательство<select name="evidence_message">${messageOptions(review.evidence[0]?.message_id || activeConversation.transcript.find(m=>m.speaker==='operator').message_id)}</select></label><label>Точная цитата (обязательна для положительного ответа)<textarea name="quote" rows="2">${esc(review.evidence[0]?.quote || '')}</textarea></label><button>Сохранить решение проверяющего</button></form></details>`}</div>`;
}
function renderSelectedRules(c) {
  $('#selected-instructions').textContent = c.instructions;
  $('#selected-rule-version').textContent = `Правила v${c.version}`;if($('#empty-criteria-count'))$('#empty-criteria-count').textContent=`Критериев: ${c.criteria.length}`;
}
function renderEditor(c) {
  if(!$('#draft-compatibility'))$('#criteria-editor').insertAdjacentHTML('beforebegin','<div id="draft-compatibility" class="compatibility-note" aria-live="polite" hidden></div>');
  $('#checklist-name').value = c.name; $('#checklist-instructions').value = c.instructions;
  $('#criteria-editor').innerHTML = c.criteria.map((x, i) => `<details class="criterion-editor" data-id="${esc(x.id)}"><summary>${esc(x.id)} · ${esc(x.name)}</summary><div class="row"><label>Название<input name="name" value="${esc(x.name)}"></label><label>Секция<input name="section" value="${esc(x.section)}"></label></div><div class="row"><label>Тип ответа<select name="type">${['boolean','scale','flag'].map(t => `<option value="${t}" ${x.type===t?'selected':''}>${{boolean:'Да / Нет',scale:'Числовая шкала',flag:'Отдельный флаг'}[t]}</option>`).join('')}</select></label><label>Вес<input name="weight" type="number" min="0" max="10000" step="0.001" value="${x.weight}"></label><label><input name="allow_na" type="checkbox" ${x.allow_na?'checked':''}> Разрешить N/A</label></div><label>Инструкция<textarea name="instruction" rows="3">${esc(x.instruction)}</textarea></label><label>Условие N/A<textarea name="na_rule" rows="2">${esc(x.na_rule)}</textarea></label><label>Каналы, где допускается N/A<select name="na_channels"><option value="all">Все каналы</option><option value="voice call" ${x.na_channels?.length===1&&x.na_channels[0]==='voice call'?'selected':''}>Только звонки</option><option value="agent chat" ${x.na_channels?.length===1&&x.na_channels[0]==='agent chat'?'selected':''}>Только чаты</option></select></label><label>Ступени числовой шкалы — каждая с новой строки: число | описание<textarea name="scale" rows="${Math.max(2,x.scale.length)}">${esc(x.scale.map(s => `${s.value} | ${s.description}`).join('\n'))}</textarea></label><div class="row"><label>Роли доказательств для положительного ответа (через запятую)<input name="positive_roles" value="${esc((x.evidence_policy?.positive_roles || ['operator']).join(','))}"></label><label>Область положительного доказательства<select name="positive_scope"><option value="any">Любая подходящая реплика</option><option value="first_operator" ${x.evidence_policy?.positive_scope==='first_operator'?'selected':''}>Первый ответ оператора</option></select></label></div><button type="button" class="danger-button remove-criterion">Удалить критерий</button></details>`).join('');
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
  refreshDraftCompatibility();updateLaunch();
}
function useConversations(records) {
  conversations = records;
  $('#conversation-select').innerHTML = conversations.map((c,i) => `<option value="${i}">${esc(c.conversation_id)} · ${c.language}</option>`).join(''); $('#conversation-select').disabled = false;
  const index=0;
  $('#conversation-select').value=String(index);
  renderResult(null); renderTranscript(conversations[index]);
  renderConversationList();showView('review');$('#import-dialog').close();
  hydrateSavedAssessments().then(()=>openConversation(Number($('#conversation-select').value))).catch(()=>{});
}
$('#file').addEventListener('change', async e => { try {
  notice(); const file = e.target.files[0]; if (!file) return;
  if (file.size > 8*1024*1024) throw Error('Файл больше 8 МБ.');
  const data = await api('/api/import', JSON.parse(await file.text())); useConversations(data.conversations);
} catch(e) { notice(e.message); } });
for (const [id,path] of [['local-dev','local-dev'],['remote-import','import']]) {
  $(`#${id}`).onclick=async()=>{ const b=$(`#${id}`); b.disabled=true; notice(); try {
    const data=await api(`/api/datasets/${path}`,path==='import'?{group_id:$('#group-id').value.trim()}:{});
    useConversations(data.conversations); notice();
  } catch(e) {notice(e.message);} finally {b.disabled=false;} };
}
$('#conversation-select').addEventListener('change', () => {openConversation(Number($('#conversation-select').value)).catch(e=>notice(e.message));});
$('#editor-toggle').onclick = () => showView('editor');
$('#checklist-select').onchange = () => { renderSelectedRules(selectedChecklist()); renderEditor(selectedChecklist());refreshDraftCompatibility();updateLaunch();renderConversationList();if(activeConversation)openConversation(Number($('#conversation-select').value)).catch(e=>notice(e.message)); };
$('#criteria-editor').onclick = e => { if(e.target.closest('.remove-criterion')){e.target.closest('.criterion-editor').remove();refreshDraftCompatibility();} };
$('#editor').addEventListener('input',refreshDraftCompatibility);
$('#editor').addEventListener('change',refreshDraftCompatibility);
$('#allow-incompatible').onchange=updateLaunch;
$('#add-criterion').onclick = () => { try { const c = collectChecklist(); c.criteria.push({id:`custom-${Date.now()}`, name:'Новый критерий', section:'', type:'boolean', weight:5, allow_na:false, na_rule:'', instruction:'Опишите условия ответа Да и Нет.', scale:[], allowed_values:['yes','no']}); renderEditor(c);refreshDraftCompatibility(); } catch(e) { notice(e.message); } };
$('#save-checklist').onclick = async () => { try { const c = await api('/api/checklists', collectChecklist()); await loadChecklists(); notice(`Сохранена версия ${c.version}.`); } catch(e) { notice(e.message); } };
$('#evaluate').onclick = async () => { running = true; updateLaunch(); notice(); try {
  requireEvaluationConsent();
  const c = selectedChecklist();
  const r = await api('/api/evaluations', { conversation:activeConversation, checklist_id:c.checklist_id, checklist_version:c.version });
  renderResult(r);mobileTab('result');await hydrateSavedAssessments();if (r.status === 'failed') notice(r.error);
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
  $('#history-list').innerHTML=records.length?records.map(r=>`<button class="history-item" data-id="${r.evaluation_id}"><strong>${esc(r.conversation_id)}</strong> · ${esc(r.checklist_name||r.checklist_id||'Чек-лист')} · ${r.checklist_version==null?'версия неизвестна':`версия ${esc(r.checklist_version)}`}<br>${r.view==='original'?'Исходная оценка':'Оценка'} · ${statusLabel(r.status)} · итог ${fmt(r.total)} · ${flagLabel(r.gross_error)}<br><span class="hint">${esc(new Date(r.created_at).toLocaleString())}${r.human_reviewed?' · Пересмотрена':''}</span></button>`).join(''):'<p class="hint">По выбранным фильтрам оценок нет.</p>';
}
$('#history-toggle').onclick=async()=>{showView('history');try{await loadHistory();}catch(e){notice(e.message);} };
$('#history-filters').onsubmit=async e=>{e.preventDefault();try{await loadHistory();}catch(err){notice(err.message);}};
for(const id of ['view','gross_error','status'])$(`#history-${id}`).onchange=async()=>{try{await loadHistory();}catch(e){notice(e.message);}};
$('#organizer-update').onclick=async()=>{try{
  const c=await api('/api/checklists/organizer-update',{});await loadChecklists();
  $('#checklist-select').value=String(checklists.findIndex(x=>x.checklist_id===c.checklist_id&&x.version===c.version));
  renderSelectedRules(c);renderEditor(c);notice(`Выбрана версия ${c.version}.`);
}catch(e){notice(e.message);}};
$('#history-list').onclick = async e => { const b = e.target.closest('[data-id]'); if (!b) return; try {const r=await api(`/api/evaluations/${b.dataset.id}`);if(!conversations.some(c=>c.conversation_id===r.conversation.conversation_id)){conversations.push(r.conversation);$('#conversation-select').innerHTML=conversations.map((c,i)=>`<option value="${i}">${esc(c.conversation_id)} · ${c.language}</option>`).join('');$('#conversation-select').disabled=false;}$('#conversation-select').value=String(conversations.findIndex(c=>c.conversation_id===r.conversation.conversation_id));showView('review');renderResult(r);await hydrateSavedAssessments();renderConversationList();mobileTab('result');} catch(e) { notice(e.message); } };
$('#export').onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(evaluation,null,2)], {type:'application/json'})); const a = document.createElement('a'); a.href=url; a.download=`cqa-${evaluation.evaluation_id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); };
function renderBatch(run){
  batchRun=run;
  $('#batch-progress').innerHTML=run?`<p><strong>${esc(({pending:'Ожидает запуска',running:'Выполняется',paused:'На паузе',completed:'Обработка завершена',interrupted:'Прерван'})[run.status]??run.status)}</strong> · обработано ${run.finished}/${run.total}</p><progress max="${run.total}" value="${run.finished}"></progress><p>Полных: ${run.counts.completed} · частичных: ${run.counts.partial} · сбоев: ${run.counts.failed} · осталось: ${run.counts.pending+run.counts.running}</p><p>Чек-лист · v${run.execution.checklist_version}</p>`:'Прогонов пока нет.';
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
    $('#batch-select').innerHTML=runs.length?runs.map(r=>`<option value="${esc(r.run_id)}">${esc(r.subset.toUpperCase())} · ${r.finished}/${r.total} · ${esc(new Date(r.created_at).toLocaleString())}</option>`).join(''):'<option value="">Прогонов пока нет</option>';
    const selected=runs.find(r=>r.run_id===id)??runs[0]??null;if(selected)$('#batch-select').value=selected.run_id;renderBatch(selected);if(selected?.error)notice(selected.error);
  }finally{batchRefreshing=false;}
}
$('#batch-refresh').onclick=async()=>{try{await refreshRuns();}catch(e){notice(e.message);}};
$('#batch-select').onchange=async()=>{try{renderBatch(await api(`/api/runs/${$('#batch-select').value}`));}catch(e){notice(e.message);}};
$('#batch-start').onclick=async()=>{
  const button=$('#batch-start');button.disabled=true;
  try{notice();requireEvaluationConsent();const c=selectedChecklist(),run=await api('/api/runs',{conversations,checklist_id:c.checklist_id,checklist_version:c.version,subset:$('#batch-subset').value,concurrency:Number($('#batch-concurrency').value)});await refreshRuns(run.run_id);}
  catch(e){notice(e.message);}finally{updateLaunch();}
};
for(const [id,action,retry] of [['batch-pause','pause',false],['batch-resume','resume',false],['batch-retry','resume',true]]){
  $(`#${id}`).onclick=async()=>{try{notice();await api(`/api/runs/${batchRun.run_id}/${action}`,{retry_failed:retry});if(action==='pause')notice('Завершаем текущие диалоги перед паузой…');await refreshRuns();}catch(e){notice(e.message);}};
}
$('#batch-export').onclick=async()=>{
  try{notice();const document=await api(`/api/runs/${batchRun.run_id}/submission`),url=URL.createObjectURL(new Blob([JSON.stringify(document,null,2)],{type:'application/json'})),a=window.document.createElement('a');a.href=url;a.download='results.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  catch(e){notice(e.message);}
};
try {
  const status = await api('/api/status');serviceStatus=status;modelReady = status.ready;
  $('#local-dev').hidden=!status.local_dev_ready;
  $('#dataset-status').textContent=status.dataset_ready?'':'Загрузка набора недоступна.';$('#dataset-status').hidden=status.dataset_ready;$('#remote-import').disabled=!status.dataset_ready;
  $('#model-status').textContent=status.ready?'':'Оценка недоступна';$('#model-status').hidden=status.ready;
  batchEnabled=Boolean(status.batch_supported);$('#nav-batch').disabled=!batchEnabled;
  if (!status.ready) notice('Оценка временно недоступна.');
  await loadChecklists(); updateLaunch();
  if(new URLSearchParams(location.search).get('embed')==='1'){
    document.body.classList.add('embedded');
    notifyParent=connectEmbed({origins:status.embed_origins??[],loadConversation:async conversation=>{const data=await api('/api/import',conversation);useConversations(data.conversations);notice();},onError:notice});
  }
  if(batchEnabled){await refreshRuns();setInterval(()=>{if(!document.hidden)refreshRuns().catch(()=>{});},3000);}
} catch(e) { notice(e.message); }
$('#nav-review').onclick=()=>showView('review');
$('#nav-batch').onclick=()=>showView('batch');
$('#open-import').onclick=()=>$('#import-dialog').showModal();
$('#conversation-list').onclick=e=>{const row=e.target.closest('[data-conversation]');if(row)openConversation(Number(row.dataset.conversation)).catch(err=>notice(err.message));if(e.target.closest('#empty-import'))$('#import-dialog').showModal();};
$('#conversation-search').oninput=renderConversationList;
for(const b of document.querySelectorAll('[data-language]'))b.onclick=()=>{languageFilter=b.dataset.language;for(const x of document.querySelectorAll('[data-language]')){x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b));}renderConversationList();};
$('#tab-transcript').onclick=()=>mobileTab('transcript');$('#tab-result').onclick=()=>mobileTab('result');
for(const event of ['dragenter','dragover'])$('#drop-zone').addEventListener(event,e=>{e.preventDefault();$('#drop-zone').classList.add('dragging');});
for(const event of ['dragleave','drop'])$('#drop-zone').addEventListener(event,e=>{e.preventDefault();$('#drop-zone').classList.remove('dragging');if(event==='drop'&&e.dataTransfer.files.length){$('#file').files=e.dataTransfer.files;$('#file').dispatchEvent(new Event('change'));}});
showView('review');mobileTab('transcript');
