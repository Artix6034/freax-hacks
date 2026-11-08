// Separate diagnostic layer. Never edits provisional labels or frozen reviews.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {hash,validateReview} from '../../src/domain.js';
import {validateDialogFacts} from '../../src/ai/facts.js';
import {calculate} from '../../src/scoring.js';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const input=await json('data/reliability/ten-disagreements/input.json');
const judgments=[
 ['p1-ru-017','02','Спорная достаточность данных',['yes','na'],'yes','Сам тикер не нужен для условного совета, но состояние поиска и прежний способ ещё не установлены. Обе трактовки относятся к реальной задаче; наличие вопроса само по себе не определяет применимость.',['m0005','m0010','m0011','m0012','m0013']],
 ['p1-ru-018','02','Вероятная ошибка рабочей метки',['na'],'na','Запрос — где узнать причину, а не установить причину отказа. Данные для навигационного следующего шага есть. Самовольный диагноз оператора не меняет исходную потребность и проверяется отдельно по 04.',['m0001','m0005','m0010','m0011','m0012']],
 ['p4-ru-001','02','Дополнительная формализация промпта',['na','yes'],'na','Приветствие и приглашение в m0013 предшествуют самостоятельной формулировке запроса в m0020–m0025. Для общего содержательного ответа m0026 содержательных уточнений нет. Текущий промпт добавляет границу первой человеческой реплики; PDF технический момент не устанавливает. Рабочая альтернатива — начало сформулированного запроса, а не последний момент перед ответом после любых уточнений.',['m0013','m0020','m0023','m0025','m0026']],
 ['p1-ru-009','05','Спорная достаточность ошибочного успокоения',['yes','no'],null,'Новое опасение о неподтверждённой личности в m0013 отдельно от первоначального вывода. Модель объяснила помощь со старой проблемой, хотя новое опасение извлечено в фактах. В ответе m0014 есть адресное, но ошибочное отрицание нужности проверки; PDF не решает, достаточно ли этого для реакции по 05. Пропуск обсуждения опасения в обосновании доказуем, обязательное Нет — нет.',['m0011','m0012','m0013','m0014','m0015','m0016']],
 ['p1-kz-015','05','Спорная достаточность ошибочного успокоения',['yes','no'],null,'Клиент в m0011 прямо указывает на отсутствие проверки; m0012 отвечает на это, отрицая необходимость. Это не буквальное отсутствие ответа. Достаточность такой реакции по 05 спорна. Модель выбрала старую проблему вывода; похожий EN-ответ оценила иначе, но тексты DEV не точные переводы и языковой эффект не установлен.',['m0010','m0011','m0012','m0013','m0014']],
 ['p1-ru-017','06','Ошибка модели: намерение принято за выполнение',[10],10,'В m0010 клиент ещё собирается найти тикер. m0011 уточняет фактическую доступность идентификатора, m0012 добавляет способ прежнего поиска. Вывод о повторе уже известного факта не следует из текста. Дальше инструкция понятна и есть конкретное подтверждение нахождения.',['m0010','m0011','m0012','m0013','m0014']],
 ['p1-ru-007','06','Граница неполноты и заметного сбоя',[7,10],10,'Инструкция понятна, клиент нашёл форму; вопрос о повторном выводе не закрыт. Страница 3 допускает высокий 06 при частичном 04. Последняя неуместная отсылка к пути вместо ответа допускает 7 как отдельный сбой, но не доказывает непонятность формулировки для 4.',['m0005','m0011','m0012','m0013']],
 ['p1-en-007','06','Граница неполноты и заметного сбоя',[7,10],10,'Путь к форме найден, условие повторного вывода осталось открытым. Модель корректно отделяет полноту от ясности; буквальная нерелевантность последней реплики допускает 7. Сходство с RU структурное, а не доказанная эквивалентность переводов.',['m0005','m0010','m0011','m0012']],
 ['p1-en-014','06','Граница пропуска и сбоя порядка',[7,10],null,'На новый вопрос о канале ответа следует только Goodbye. Это наблюдаемая неполнота по 04. Для 06 возможны ясная, но неполная консультация 10 либо заметное завершение вместо ответа 7. Причинного переспроса непонятной инструкции нет; 4 не поддержано.',['m0012','m0013','m0014','m0015']],
 ['p1-ru-022','06','Возврат к цели или возражение против услуги',[4,7,10],null,'Клиент возвращает разговор к консультации, а не только отказывается от услуги. Для 4 есть отдельное основание по направлению ответа, независимо от 08; 7 — понятный уход от темы. Но фраза также читается как возражение против содержания при ясном общении, допускающее 10. Ни старая метка, ни ответ модели не независимый эталон.',['m0001','m0010','m0011','m0012','m0013']]
];
const cases=[];
for(const [id,criterion_id,classification,plausible_values,preferred,reason,ids] of judgments){
 const source=input.cases.find(c=>c.id===id);assert.ok(source);
 const record=await json(`data/${source.evaluation_id}.json`);
 assert.deepEqual(record.conversation.transcript,source.transcript);assert.equal(hash(record.conversation),source.conversation_hash);
 assert.deepEqual(record.ai_review.criteria,source.all_evaluations);
 validateReview(record.ai_review,record.checklist,record.conversation);validateDialogFacts(record.ai_facts,record.conversation);
 assert.deepEqual(record.original_score,calculate(record.checklist,record.ai_review,record.conversation.channel));
 const target=source.criteria.find(c=>c.key.endsWith(':'+criterion_id)),original=source.source_label.criteria.find(c=>c.criterion_id===criterion_id),model=record.ai_review.criteria.find(c=>c.criterion_id===criterion_id);
 assert.ok(target&&original&&model);
 cases.push({id,criterion_id,full_transcript_reviewed:true,transcript_messages:source.transcript.length,evaluation_id:source.evaluation_id,original_label:original.value,original_reason:original.explanation,working_label:target.expected,working_reason:target.reference_explanation,model_value:model.value,model_reason:model.explanation,classification,plausible_values,preferred,reason,evidence:ids.map(id=>{const m=source.transcript.find(m=>m.message_id===id);assert.ok(m);return m;})});
}
assert.equal(cases.length,10);assert.equal(new Set(cases.map(c=>c.id)).size,9);
const report={notice:'Manual transcript/PDF diagnostic review by this assistant; familiar DEV, not independent GT. All ten requested positions retained; no metric exclusions or label changes.',pdf_pages_read:[1,2,3],cases,new_model_calls:0};
await writeFile(new URL('./dev-diagnostic.json',import.meta.url),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({positions:cases.length,complete_dialogues:new Set(cases.map(c=>c.id)).size,immutable_sources_validated:true}));
