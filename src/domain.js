import { createHash } from 'node:crypto';

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const requireThat = (condition, message) => { if (!condition) throw new InputError(message); };
export const nonempty = v => typeof v === 'string' && v.trim().length > 0;
export const decisionStatus = r => r?.status ?? 'resolved';
export const reviewStatus = review => review?.criteria?.some(r => decisionStatus(r)==='unresolved') ? 'partial' : 'completed';
export function naAllowed(c, channel) { return c.allow_na && (!c.na_channels || !channel || c.na_channels.includes(channel)); }
export function validateDecisionValue(c,r,channel) {
  const status=decisionStatus(r);
  requireThat(['resolved','unresolved'].includes(status),`Неизвестный статус критерия ${c.id}.`);
  if(status==='unresolved') {
    requireThat(r.value===null && nonempty(r.explanation) && Array.isArray(r.missing_information) && r.missing_information.length>0 && r.missing_information.every(nonempty),`Нужны value=null и конкретные missing_information для ${c.id}.`);
    requireThat(!r.na_reason && !r.na_condition,`Unresolved не является N/A (${c.id}).`);
  } else {
    requireThat(c.allowed_values.includes(r.value),`Недопустимый ответ по ${c.id}.`);
    requireThat(r.missing_information===undefined || (Array.isArray(r.missing_information)&&r.missing_information.length===0),`Определённый ответ ${c.id} не должен содержать missing_information.`);
    if(r.value==='na') {
      requireThat(naAllowed(c,channel),`N/A запрещён для канала ${channel} (${c.id}).`);
      if(c.na_condition) requireThat(r.na_condition===c.na_condition,`Нужно явно подтвердить условие N/A ${c.na_condition} (${c.id}).`);
    } else requireThat(!r.na_condition,`Условие N/A не применяется к ${c.id}.`);
  }
  return status;
}
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function importConversations(input) {
  requireThat(input && typeof input === 'object', 'Нужен JSON-объект диалога или массив.');
  if (input && 'isSuccess' in input) requireThat(input.isSuccess === true, 'API организаторов вернул ошибку.');
  const records = Array.isArray(input) ? input : input?.data?.records ?? [input];
  requireThat(Array.isArray(records) && records.length > 0, 'Нужен диалог или непустой data.records.');
  return records.map(normalizeConversation);
}

export function normalizeConversation(c) {
  requireThat(c && nonempty(c.conversation_id), 'Не указан conversation_id.');
  requireThat(['agent chat', 'voice call'].includes(c.channel), 'Неизвестный channel.');
  requireThat(['RU', 'KZ', 'EN'].includes(c.language), 'Ожидается язык RU, KZ или EN.');
  requireThat(c.audio_url == null || (typeof c.audio_url === 'string' && (c.audio_url === '' || /^https?:\/\//i.test(c.audio_url))), 'Некорректный audio_url.');
  requireThat(Array.isArray(c.transcript) && c.transcript.length > 0, 'Транскрипт пуст или не является массивом.');
  const transcript = c.transcript.map((m, i) => {
    requireThat(m && ['client', 'operator', 'bot', 'system'].includes(m.speaker), `Неизвестная роль в сообщении ${i + 1}.`);
    requireThat(nonempty(m.text) && nonempty(m.timestamp), `Нет текста или времени в сообщении ${i + 1}.`);
    const timeOK = c.channel === 'agent chat' ? /^\d{2,}:[0-5]\d$/.test(m.timestamp)
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(m.timestamp) && Number.isFinite(Date.parse(m.timestamp));
    requireThat(timeOK, `Некорректное время сообщения ${i + 1}; исходная метка должна соответствовать каналу.`);
    return { message_id: `m${String(i + 1).padStart(4, '0')}`, timestamp: m.timestamp, speaker: m.speaker, text: m.text };
  });
  return { schema_version: '1.0', conversation_id: c.conversation_id, channel: c.channel,
    language: c.language, audio_url: c.audio_url ?? null, transcript };
}

export function validateChecklist(c) {
  requireThat(c && c.schema_version === '1.0' && nonempty(c.checklist_id) && nonempty(c.name), 'Некорректный чек-лист.');
  requireThat(Number.isInteger(c.version) && c.version > 0, 'Версия должна быть положительным целым числом.');
  requireThat(c.rounding === 'ROUND_HALF_UP' && nonempty(c.instructions), 'Нужны инструкции и ROUND_HALF_UP.');
  requireThat(Array.isArray(c.criteria) && c.criteria.length > 0 && c.criteria.length <= 100, 'Нужно от 1 до 100 критериев.');
  const ids = new Set();
  for (const x of c.criteria) {
    requireThat(x && nonempty(x.id) && !ids.has(x.id), 'ID критериев должны быть непустыми и уникальными.'); ids.add(x.id);
    requireThat(nonempty(x.name) && nonempty(x.instruction) && typeof x.section === 'string', `Нет описания ${x.id}.`);
    requireThat(['boolean', 'scale', 'flag'].includes(x.type), `Неизвестный тип ${x.id}.`);
    requireThat(Number.isFinite(x.weight) && x.weight >= 0 && x.weight <= 10000 && /^\d+(?:\.\d{1,3})?$/.test(String(x.weight)), `Вес ${x.id}: 0–10000, до 3 знаков после запятой.`);
    requireThat(typeof x.allow_na === 'boolean' && typeof x.na_rule === 'string' && (!x.allow_na || nonempty(x.na_rule)), `Нужно условие N/A для ${x.id}.`);
    if(x.na_channels!==undefined) requireThat(x.allow_na && Array.isArray(x.na_channels) && x.na_channels.length>0 && x.na_channels.every(v=>['agent chat','voice call'].includes(v)) && new Set(x.na_channels).size===x.na_channels.length,`Некорректные каналы N/A ${x.id}.`);
    if(x.na_condition!==undefined) requireThat(x.allow_na && nonempty(x.na_condition),`Некорректное условие N/A ${x.id}.`);
    requireThat(Array.isArray(x.scale) && Array.isArray(x.allowed_values), `Нет шкалы/значений ${x.id}.`);
    let expected = ['yes', 'no'];
    if (x.type === 'scale') {
      requireThat(x.scale.length >= 2 && x.scale.every(s => s && Number.isInteger(s.value) && s.value >= 0 && s.value <= 1000000 && nonempty(s.description)), `Некорректная шкала ${x.id}.`);
      const values = x.scale.map(s => s.value);
      requireThat(new Set(values).size === values.length && Math.min(...values) === 0 && Math.max(...values) > 0, `Шкала ${x.id} должна содержать 0 и положительный максимум без дублей.`);
      expected = values;
    } else requireThat(x.scale.length === 0, `У ${x.id} не должно быть числовой шкалы.`);
    if (x.type === 'flag') requireThat(x.weight === 0 && !x.allow_na, 'Флаг должен иметь нулевой вес и не поддерживать N/A.');
    if (x.evidence_policy) {
      requireThat(Array.isArray(x.evidence_policy.positive_roles) && x.evidence_policy.positive_roles.length > 0 && x.evidence_policy.positive_roles.every(r => ['client','operator','bot','system'].includes(r)), `Некорректные роли доказательств ${x.id}.`);
      requireThat(['any','first_operator'].includes(x.evidence_policy.positive_scope), `Некорректная область доказательств ${x.id}.`);
    }
    if (x.allow_na) expected = [...expected, 'na'];
    requireThat(expected.length === x.allowed_values.length && new Set(x.allowed_values).size === expected.length && expected.every(v => x.allowed_values.includes(v)), `allowed_values не соответствуют типу/шкале ${x.id}.`);
  }
  return c;
}

export function validateReview(review, checklist, conversation) {
  validateChecklist(checklist);
  requireThat(review && Array.isArray(review.criteria) && review.criteria.length === checklist.criteria.length, 'AI должен вернуть все критерии ровно один раз.');
  const messages = conversation.transcript;
  const byId = new Map(messages.map((m, i) => [m.message_id, { ...m, index: i }]));
  const seen = new Set();
  for (const r of review.criteria) {
    const c = checklist.criteria.find(c => c.id === r?.criterion_id);
    requireThat(c && !seen.has(c.id), 'Неизвестный или повторный criterion_id.'); seen.add(c.id);
    const status=validateDecisionValue(c,r,conversation.channel);
    requireThat(nonempty(r.explanation), `Нет обоснования ${c.id}.`);
    requireThat(Array.isArray(r.evidence) && Array.isArray(r.checked_ranges), `Нужны evidence и checked_ranges для ${c.id}.`);
    if(status==='resolved') requireThat(r.evidence.length + r.checked_ranges.length > 0, `Нет доказательства или проверенного участка ${c.id}.`);
    requireThat(typeof r.na_reason === 'string' && (r.value !== 'na' || (c.allow_na && nonempty(r.na_reason))), `Нужно допустимое объяснение N/A ${c.id}.`);
    for (const e of r.evidence) {
      const m = byId.get(e?.message_id);
      requireThat(m && nonempty(e.quote) && m.text.includes(e.quote), `Неизвестное сообщение или несовпадающая цитата ${c.id}.`);
    }
    for (const range of r.checked_ranges) {
      const start = byId.get(range?.from_message_id), end = byId.get(range?.to_message_id);
      requireThat(start && end && start.index <= end.index && nonempty(range.expected_action), `Неверный проверенный диапазон ${c.id}.`);
    }
    const positive = r.value === 'yes' || (typeof r.value === 'number' && r.value > 0);
    if (positive && c.evidence_policy) {
      requireThat(r.evidence.some(e => c.evidence_policy.positive_roles.includes(byId.get(e.message_id).speaker)), `Положительная оценка ${c.id} требует цитаты допустимой роли.`);
      if (c.evidence_policy.positive_scope === 'first_operator') {
        const first = messages.find(m => m.speaker === 'operator');
        requireThat(first && r.evidence.some(e => e.message_id === first.message_id), `Оценка ${c.id} требует доказательства в первом ответе оператора.`);
      }
    }
    if (c.type === 'flag' && r.value === 'no') {
      const covered = new Set();
      for (const range of r.checked_ranges) {
        for (let i = byId.get(range.from_message_id).index; i <= byId.get(range.to_message_id).index; i++) covered.add(i);
      }
      requireThat(covered.size === messages.length, `При отсутствии грубых ошибок проверяется весь диалог (${c.id}).`);
    }
  }
  return review;
}
