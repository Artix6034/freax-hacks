import { InputError, importConversations, requireThat } from './domain.js';

export function datasetReady(endpoint) {
  try { const u = new URL(endpoint); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
export async function importRemoteDataset(endpoint, groupId, fetchImpl = fetch) {
  if (!datasetReady(endpoint)) throw new InputError('Адрес API набора не настроен. Задайте CQA_DATASET_URL на сервере.', 503);
  requireThat(typeof groupId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(groupId), 'group_id: от 1 до 64 букв, цифр, дефисов или подчёркиваний.');
  const url = new URL(endpoint); url.searchParams.set('group_id', groupId);
  let response;
  try { response = await fetchImpl(url, { method:'GET', signal:AbortSignal.timeout(60000), redirect:'error' }); }
  catch { throw new InputError('Не удалось получить набор. Проверьте настройки API и доступность сервиса.', 502); }
  if (!response.ok) throw new InputError(`API набора вернул HTTP ${response.status}.`, 502);
  const chunks=[]; let size=0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8*1024*1024) throw new InputError('Ответ API больше 8 МБ.', 413);
      chunks.push(chunk);
    }
  } catch(e) { if (e instanceof InputError) throw e; throw new InputError('Загрузка набора прервана.', 502); }
  let data;
  try { data=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('API набора вернул некорректный JSON.', 502); }
  return importConversations(data);
}
