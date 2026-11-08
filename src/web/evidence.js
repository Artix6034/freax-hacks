const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const roleLabel = role => ({client:'Клиент',operator:'Оператор',bot:'Бот',system:'Система'}[role] ?? role);

// Derived presentation only: roles, times and surrounding text come from the
// saved Conversation. This never enriches or changes the stored AIReview.
export function deriveEvidence(review, conversation) {
  const messages=conversation.transcript;
  const byId=new Map(messages.map((m,index)=>[m.message_id,{message:m,index}]));
  const context=(first,last)=>{
    const indexes=[...new Set([first-1,first,first+1,last-1,last,last+1])].filter(i=>i>=0&&i<messages.length).sort((a,b)=>a-b);
    return indexes.map((i,n)=>({...messages[i],selected:i>=first&&i<=last,
      omitted_before:n>0?i-indexes[n-1]-1:0}));
  };
  return [
    ...(review.evidence ?? []).map(e=>{
      const source=byId.get(e.message_id);
      if (!source || typeof e.quote!=='string' || !e.quote || !source.message.text.includes(e.quote)) return {kind:'quote',available:false,message_id:e.message_id};
      return {kind:'quote',available:true,message_id:e.message_id,timestamp:source.message.timestamp,speaker:source.message.speaker,quote:e.quote,
        from_message_id:e.message_id,to_message_id:e.message_id,context:context(source.index,source.index)};
    }),
    ...(review.checked_ranges ?? []).map(range=>{
      const first=byId.get(range.from_message_id),last=byId.get(range.to_message_id);
      if (!first || !last || first.index>last.index) return {kind:'range',available:false,from_message_id:range.from_message_id,to_message_id:range.to_message_id};
      return {kind:'range',available:true,from_message_id:range.from_message_id,to_message_id:range.to_message_id,
        from_timestamp:first.message.timestamp,to_timestamp:last.message.timestamp,from_speaker:first.message.speaker,to_speaker:last.message.speaker,
        expected_action:range.expected_action,context:context(first.index,last.index)};
    })
  ];
}

export function renderEvidenceHTML(review, conversation) {
  const esc=escapeHTML;
  const cards=deriveEvidence(review,conversation);
  if (!cards.length) return '<p class="hint">Источники не указаны.</p>';
  return cards.map(card=>{
    if (!card.available) return `<p class="hint source-unavailable">Источник ${esc(card.message_id ?? `${card.from_message_id}-${card.to_message_id}`)} недоступен или не совпадает с сохранённым транскриптом.</p>`;
    const title=card.kind==='quote'?'Сообщение-доказательство':'Проверенный участок';
    const source=card.kind==='quote'
      ? `${esc(card.timestamp)} · ${esc(roleLabel(card.speaker))} · ${esc(card.message_id)}`
      : `${esc(card.from_timestamp)} · ${esc(roleLabel(card.from_speaker))} · ${esc(card.from_message_id)} → ${esc(card.to_timestamp)} · ${esc(roleLabel(card.to_speaker))} · ${esc(card.to_message_id)}`;
    return `<div class="evidence-card ${card.kind}"><button class="proof" data-from="${esc(card.from_message_id)}" data-to="${esc(card.to_message_id)}"><strong>${title}</strong><span class="proof-source">${source}</span>${card.kind==='quote'?`<span class="proof-quote">«${esc(card.quote)}»</span>`:`<span class="proof-action">Ожидалось / проверялось: ${esc(card.expected_action)}</span>`}<span class="proof-link">Показать в транскрипте</span></button><details class="proof-context"><summary>Контекст</summary>${card.context.map(m=>`${m.omitted_before?`<p class="hint">… пропущено сообщений: ${m.omitted_before}</p>`:''}<div class="context-message ${m.selected?'selected':''}"><div class="hint">${esc(m.timestamp)} · ${esc(roleLabel(m.speaker))} · ${esc(m.message_id)} · ${m.selected?'Выбранное сообщение / участок':'Соседнее сообщение'}</div><div class="message-text">${esc(m.text)}</div></div>`).join('')}</details></div>`;
  }).join('');
}
