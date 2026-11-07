import { reviewStatus, requireThat } from './domain.js';

export function summarizeEvaluation(r, view='final') {
  const ai_status=r.ai_status ?? (r.ai_review?reviewStatus(r.ai_review):r.status==='running'?'running':'failed');
  const final_status=r.final_status ?? (r.final_review?reviewStatus(r.final_review):r.status);
  const score=view==='original'?r.original_score:r.final_score;
  return {evaluation_id:r.evaluation_id,conversation_id:r.conversation.conversation_id,
    checklist_id:r.checklist?.checklist_id??null,checklist_version:r.checklist?.version??null,checklist_name:r.checklist?.name??null,
    run_id:r.run_id??null,prompt_version:r.prompt_version??r.ai_metadata?.prompt_version??null,schema_version:r.ai_metadata?.schema_version??null,
    model:r.ai_metadata?.model??null,configuration_hash:r.configuration_hash??null,
    view,ai_status,final_status,status:view==='original'?ai_status:final_status,created_at:r.created_at,
    total:score?.total??null,gross_error:score?.gross_error??null,human_reviewed:r.appeals?.some(a=>a.status==='resolved')??false};
}
export function filterHistory(records, params=new URLSearchParams()) {
  const view=params.get('view')||'final';requireThat(['final','original'].includes(view),'Неизвестное представление истории.');
  const flag=params.get('gross_error')||'all';requireThat(['all','yes','no','unknown'].includes(flag),'Неизвестный фильтр грубых ошибок.');
  const id=(params.get('conversation_id')||'').toLowerCase(),status=params.get('status')||'',version=params.get('checklist_version')||'';
  requireThat(!status||['completed','partial','failed','running'].includes(status),'Неизвестный статус истории.');
  requireThat(!version||/^\d+$/.test(version),'Версия чек-листа должна быть числом.');
  const run=params.get('run_id')||'';
  return records.map(r=>summarizeEvaluation(r,view)).filter(r=>(!run||r.run_id===run)&&(!id||r.conversation_id.toLowerCase().includes(id))&&(!status||r.status===status)&&(!version||String(r.checklist_version)===version)&&(flag==='all'||(flag==='yes'?r.gross_error===true:flag==='no'?r.gross_error===false:r.gross_error===null)));
}
