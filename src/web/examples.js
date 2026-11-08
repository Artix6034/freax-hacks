// Public teaching material. No labels or scores are supplied.
export const TEACHING_CONVERSATION={
 conversation_id:'TEACHING_EXAMPLE_RU',channel:'agent chat',language:'RU',
 transcript:[
  {speaker:'system',timestamp:'00:00',text:'Учебный диалог. Все реплики вымышлены.'},
  {speaker:'client',timestamp:'00:01',text:'Здравствуйте! Можно задать вопрос о работе приложения?'},
  {speaker:'operator',timestamp:'00:02',text:'Добрый день! Я Анна, специалист поддержки Freedom Broker. Конечно, подскажите, какой вопрос хотите обсудить?'},
  {speaker:'client',timestamp:'00:03',text:'Я уже разобрался, спасибо. Больше вопросов нет.'},
  {speaker:'operator',timestamp:'00:04',text:'Пожалуйста! Если появятся вопросы, напишите сюда. Хорошего дня!'}
 ]
};
export function filterCollection(files,query='',language='all'){
 const needle=String(query).trim().toLocaleLowerCase();
 return files.filter(file=>(language==='all'||file.language===language)&&(!needle||`${file.id} ${file.preview||''}`.toLocaleLowerCase().includes(needle)));
}
