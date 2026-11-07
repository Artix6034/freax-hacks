import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const pack=await read('data/reliability/criterion06-review/input-pack.json'),judgments=await read('research/reliability/criterion06-assessments.json');
assert.equal(judgments.cases.length,14);assert.equal(new Set(judgments.cases.map(c=>c.id)).size,14);
const counts={runtime_error:0,annotation_error:0,disputed:0};
const cases=judgments.cases.map(j=>{
 const c=pack.cases.find(c=>c.conversation_id===j.id);assert.ok(c);assert.ok(Object.hasOwn(counts,j.classification));counts[j.classification]++;
 assert.ok(j.acceptable.includes(j.preferred)&&j.acceptable.every(v=>[0,4,7,10].includes(v)));
 const evidence=j.evidence_ids.map(id=>{const m=c.transcript.find(m=>m.message_id===id);assert.ok(m);return m;});
 if(j.classification==='annotation_error')assert.equal(j.preferred,c.runtime.value);
 if(j.classification==='runtime_error')assert.equal(j.preferred,c.data_chat.value);
 return {...j,conversation_id:j.id,data_chat_value:c.data_chat.value,runtime_value:c.runtime.value,
  data_chat_explanation:c.data_chat.explanation,runtime_explanation:c.runtime.explanation,evaluation_id:c.evaluation_id,
  transcript_hash:c.transcript_hash,previously_reserved_holdout:c.previously_reserved_holdout,evidence};
});
const report={notice:judgments.authority,run_id:pack.run_id,production_scores_changed:false,new_model_calls:0,counts,holdout_notice:pack.holdout_notice,cases};
const dir='data/reliability/criterion06-review';await writeFile(dir+'/adjudication.json',JSON.stringify(report,null,2));
const label={runtime_error:'Избыточное снижение моделью',annotation_error:'Ошибка предварительной разметки',disputed:'Спорная граница'};
const lines=['Freax — разбор 14 расхождений по критерию 06',report.notice,
 'Прочитаны полные транскрипты всех 14 чатов и все 3 страницы PDF. Это выводы ассистента, а не новые экспертные/официальные метки.',
 `Итог: ${counts.runtime_error} случаев с более обоснованной оценкой data_chat; ${counts.annotation_error} с более обоснованной оценкой рабочей модели; ${counts.disputed} спорных.`,
 'Предпочтительные оценки в спорных случаях не объявлены единственно допустимыми. Официальные результаты и исходная разметка не переписаны.',
 '', 'Основание PDF:',
 '10 — ясное и связное общение с предупреждением при явном ожидании; 7 — один заметный сбой с возможностью понять ответ и продолжить;',
 '4 — переспрос, вызванный формулировкой или порядком ответов; 0 — ход непонятен из-за бессвязности/противоречий.',
 'Страница 3 прямо разделяет полноту консультации и понятность общения. Нельзя считать любое уточнение или любую ошибку по другому критерию достаточным основанием для снижения 06.',
 '',...cases.flatMap(c=>[
 `${c.id}: data_chat ${c.data_chat_value}, модель ${c.runtime_value}; ${label[c.classification]}; предпочтительно ${c.preferred}${c.classification==='disputed'?' (допустимые трактовки '+c.acceptable.join('/')+')':''}. Уверенность: ${c.confidence}.`,
 c.reason,`Обоснование data_chat: ${c.data_chat_explanation}`,`Обоснование модели: ${c.runtime_explanation}`,
 ...c.evidence.map(m=>`${m.message_id} ${m.timestamp} ${m.speaker}: ${m.text}`),'']),
 'Причины ошибок модели: подтверждение принимается за непонимание; пошаговый разговор — за неполную инструкцию; полнота/правильность консультации переносится в 06; любое повторное упоминание считается заметным сбоем.',
 'Причина ошибок data_chat: повтор известного факта приравнивается к переспросу из-за неясности.',
 'Предлагаемое следующее изменение: отдельно проверять причину уточнения и фактический сбой понятности; не добавлять обязательные фразы клиента, правило «все шаги одним сообщением» или общий запрет нескольким критериям учитывать одно действие.',
 'В этом разборе системный промпт, чек-лист, сохранённые оценки и results/dev/results.json не менялись.',
 report.holdout_notice,
 'Проверка KZ носителем и независимая экспертная проверка остаются желательными.'];
await writeFile(dir+'/adjudication.txt',lines.join('\n')+'\n');
await mkdir('docs',{recursive:true});
const publicLines=['Freax — итоги разбора критерия 06',report.notice,
 'Источник: CQA_Chat_Quality_Checklist 1.pdf, все 3 страницы. Из 14: 8 снижений модели недостаточно обоснованы, 3 ошибки предварительной разметки, 3 спорных случая.',
 'Это аналитические выводы ассистента, а не официальный или независимый человеческий Ground Truth. Оценки приложения и файл сдачи сохранены без изменения.',
 '', 'Диалог | data_chat | модель | предпочтительно | вывод',
 ...cases.map(c=>`${c.id} | ${c.data_chat_value} | ${c.runtime_value} | ${c.classification==='disputed'?c.acceptable.join('/'):c.preferred} | ${label[c.classification]}`),
 '',...cases.flatMap(c=>[c.id+': '+c.reason,'Основания: '+c.evidence.map(m=>m.message_id+' '+m.timestamp).join(', '),'']),
 'Полные исходные реплики и объяснения сторон — локальный data/reliability/criterion06-review/adjudication.txt и .json; приватные данные в Git не включаются.',
 report.holdout_notice,
 'Следующая проверка промпта должна различать подтверждение понимания, следующий шаг навигации, уточнение недостающих данных и переспрос из-за неясности. Не вводить запрет на вопросы клиента или требование одной полной инструкции в первом ответе.'
 ];await writeFile('docs/criterion06-review.txt',publicLines.join('\n')+'\n');
console.log(JSON.stringify({counts,reviewed_cases:cases.length,new_model_calls:0,production_scores_changed:false,report:dir+'/adjudication.txt',team_summary:'docs/criterion06-review.txt'}));
