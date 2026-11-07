import { InputError } from '../domain.js';

export function aiFailure(message, code) {
  const error=new InputError(message,502); error.ai_code=code; return error;
}

// Never retain provider error bodies, raw refusals, request headers or reasoning text.
export function cleanUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const result={};
  for (const key of ['prompt_tokens','completion_tokens','total_tokens']) {
    if (Number.isSafeInteger(usage[key]) && usage[key]>=0) result[key]=usage[key];
  }
  for (const key of ['prompt_tokens_details','completion_tokens_details']) {
    if (!usage[key] || typeof usage[key]!=='object') continue;
    const details={};
    for (const item of ['cached_tokens','cache_write_tokens','reasoning_tokens','audio_tokens','text_tokens','image_tokens','accepted_prediction_tokens','rejected_prediction_tokens']) {
      if (Number.isSafeInteger(usage[key][item]) && usage[key][item]>=0) details[item]=usage[key][item];
    }
    result[key]=details;
  }
  return result;
}

export async function requestChat(config, body, call, fetchImpl) {
  let response;
  try {
    response=await fetchImpl(`${config.baseUrl.replace(/\/$/,'')}/chat/completions`,{
      method:'POST',headers:{'Content-Type':'application/json',...(config.apiKey?{Authorization:`Bearer ${config.apiKey}`}:{})},
      body:JSON.stringify(body),signal:AbortSignal.timeout(config.timeoutMs),redirect:'error'
    });
  } catch(e) {
    if (e.name==='TimeoutError' || e.name==='AbortError') throw aiFailure('Модель не ответила за отведённое время.','TIMEOUT');
    throw aiFailure('Не удалось подключиться к AI. Проверьте адрес и доступность сервиса.','NETWORK_ERROR');
  }
  call.http_status=response.status ?? (response.ok?200:null);
  if (!response.ok) throw aiFailure(`AI вернул HTTP ${response.status}. Проверьте доступ, модель и формат ответа.`,'HTTP_ERROR');
  try { return await response.json(); }
  catch(e) {
    if (e.name==='TimeoutError' || e.name==='AbortError') throw aiFailure('Чтение ответа модели прервано по времени.','TIMEOUT');
    throw aiFailure('AI вернул ответ не в JSON.','INVALID_JSON');
  }
}
