// State used by the workflow diagram. No generated metrics or simulated stages.
export function workflowState(s){
 const complete=s.evaluationStatus==='completed',partial=s.evaluationStatus==='partial',failed=s.evaluationStatus==='failed';
 const reviewed=complete||partial;
 return {
  summary:s.running?'Анализ выполняется':complete?'Результат готов':partial?'Нужна проверка':failed?'Ошибка оценки':!s.active?'Ожидает диалог':!s.modelReady?'Нужна модель':'Готов к запуску',
  mode:s.running?'Выполняется':reviewed?'Результат получен':failed?'Ошибка':'Ожидание',
  stages:[
   {id:'import',state:s.active?'done':'blocked',label:s.active?'Транскрипт выбран':'Не загружен'},
   {id:'rules',state:s.criteria?'done':'blocked',label:s.criteria?`${s.criteria} критериев · v${s.version}`:'Загрузка'},
   {id:'ai',state:s.running?'active':failed?'error':reviewed?'done':s.modelReady?'ready':'blocked',label:s.running?'Обрабатывается':failed?'Сбой':reviewed?'Ответ получен':s.modelReady?'Готов к запуску':'Нет подключения'},
   {id:'review',state:reviewed?'ready':'blocked',label:complete?'Проверьте источники':partial?'Есть неопределённость':'Ожидает результат'}
  ],
  log:s.running?'Запрос отправлен. Ожидаем ответ модели.':reviewed?'Проверьте цитаты. При необходимости подайте апелляцию.':failed?'Ошибка оценки. Подробности в результате.':!s.active?'Выберите диалог и чек-лист.':!s.modelReady?'Для оценки требуется подключение модели.':'Можно запускать оценку.'
 };
}
export function appendNotice(items,message,now=Date.now()){
 if(typeof message!=='string'||!message.trim())return items;
 if(items[0]?.message===message)return items;
 return [{message,time:now},...items].slice(0,30);
}
