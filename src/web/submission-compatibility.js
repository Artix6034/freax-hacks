// Shared by the browser and the exporter. No DOM, model calls or score conversion.
export const SUBMISSION_CRITERIA = Object.freeze([
  { id:'01', code:'contact', type:'boolean', values:[true,false,null], weight:10 },
  { id:'02', code:'discovery', type:'boolean', values:[true,false,null], weight:15 },
  { id:'03', code:'identification', type:'boolean', values:[true,false,null], weight:20 },
  { id:'04', code:'consultation', type:'scale', values:[0,5,10,15,20,null], weight:20 },
  { id:'05', code:'empathy', type:'boolean', values:[true,false], weight:15 },
  { id:'06', code:'dialogue', type:'scale', values:[0,4,7,10], weight:15 },
  { id:'07', code:'closure', type:'boolean', values:[true,false,null], weight:5 },
  { id:'08', code:'critical', type:'flag', values:[true,false], weight:0 }
].map(c=>Object.freeze({...c,values:Object.freeze(c.values)})));

export function submissionCompatibility(checklist) {
  const criteria=checklist?.criteria,issues=[],warnings=[];
  if(!Array.isArray(criteria))return {compatible:false,issues:[{code:'CRITERIA_REQUIRED',message:'Нет списка критериев для проверки формата сдачи.'}],warnings};
  const ids=criteria.map(c=>c.id);
  if(criteria.length!==8||new Set(ids).size!==8||SUBMISSION_CRITERIA.some(c=>!ids.includes(c.id)))
    issues.push({code:'CRITERION_SET',message:'Формат сдачи 1.0 требует восемь исходных критериев 01–08. Новый, удалённый или переименованный ID нужно согласовать с организаторами.'});
  for(const spec of SUBMISSION_CRITERIA){
    const c=criteria.find(c=>c.id===spec.id);if(!c)continue;
    if(c.type!==spec.type)issues.push({code:'TYPE',criterion_id:c.id,message:`${c.id} (${spec.code}): изменён тип ответа; формат сдачи требует ${spec.type}.`});
    if(spec.type==='scale'&&c.type==='scale'){
      const values=Array.isArray(c.scale)?c.scale.map(s=>s.value).sort((a,b)=>a-b):[];
      const expected=spec.values.filter(v=>typeof v==='number');
      if(values.length!==expected.length||values.some((v,i)=>v!==expected[i]))
        issues.push({code:'SCALE',criterion_id:c.id,message:`${c.id} (${spec.code}): для сдачи разрешены ступени ${expected.join(', ')}. Другая шкала не преобразуется автоматически.`});
    }
    if(c.allow_na&&!spec.values.includes(null))warnings.push({code:'NA_VALUE',criterion_id:c.id,channels:c.na_channels??null,
      message:`${c.id} (${spec.code}): чек-лист разрешает N/A${c.na_channels?.length?' для '+c.na_channels.join(', '):''}, но формат сдачи не допускает null. Диалог с таким ответом будет выгружен как error.`});
    if(c.id==='01'&&c.allow_na&&(c.na_condition!=='recording_started_after_greeting'||c.na_channels?.length!==1||c.na_channels[0]!=='voice call'))
      warnings.push({code:'CONTACT_NA_SCOPE',criterion_id:c.id,message:'N/A по contact разрешён только для DEV-звонка с подтверждённым отсутствием начала записи и приветствия. Для других условий и текстовых чатов null не допускается.'});
  }
  return {compatible:issues.length===0,issues,warnings};
}
