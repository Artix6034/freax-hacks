// Offline report for one explicit run. Reads private data; never calls a model or rewrites labels/results.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hash} from '../../src/domain.js';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const id=process.argv[2];assert.match(id??'',/^[0-9a-f-]{36}$/);
const run=await read(`data/runs/${id}.json`);assert.equal(run.status,'completed');assert.equal(run.execution.reference_hash,hash(''));
const old=await read('data/runs/608e0e6b-72f4-4ea6-b34f-3c1bbaa04704.json');
const rows=[],counts={},oldCounts={},changes={},unresolved={},failed=[],transitions={};let knownAnswers=0,oldKnownAnswers=0;
for(const task of run.tasks){
 const r=await read(`data/${task.evaluation_id}.json`),previous=await read(`data/${old.tasks.find(t=>t.conversation_id===task.conversation_id).evaluation_id}.json`);
 assert.deepEqual(r.conversation,previous.conversation);assert.equal(r.configuration_hash,run.configuration_hash);
 counts[r.status]=(counts[r.status]??0)+1;
 oldCounts[previous.status]=(oldCounts[previous.status]??0)+1;
 const transition=`${previous.status}->${r.status}`;transitions[transition]=(transitions[transition]??0)+1;
 oldKnownAnswers+=previous.ai_review?.criteria.filter(c=>c.status!=='unresolved').length??0;
 knownAnswers+=r.ai_review?.criteria.filter(c=>c.status!=='unresolved').length??0;
 if(r.status==='failed')failed.push({id:task.conversation_id,error:r.error});
 const differences=[];
 for(const c of r.ai_review?.criteria??[]){const before=previous.ai_review.criteria.find(p=>p.criterion_id===c.criterion_id);
  if(before.value!==c.value||before.status!==c.status){changes[c.criterion_id]=(changes[c.criterion_id]??0)+1;differences.push({criterion_id:c.criterion_id,before:before.value,before_status:before.status,after:c.value,after_status:c.status,explanation:c.explanation});}
  if(c.status==='unresolved')unresolved[c.criterion_id]=(unresolved[c.criterion_id]??0)+1;
 }
 rows.push({id:task.conversation_id,channel:r.conversation.channel,status:r.status,before:previous.status,original_total:previous.original_score?.total??null,new_total:r.original_score?.total??null,
  gross_error:r.original_score?.gross_error??null,attempts:task.attempts.length,differences,
  missing:r.ai_review?.criteria.filter(c=>c.status==='unresolved').map(c=>({id:c.criterion_id,missing_information:c.missing_information}))??[]});
}
const report={notice:'Observed output changes, not independent accuracy or official GT. Partial and failed results remain explicit.',run_id:id,prompt:run.execution.prompt_version,configuration_hash:run.configuration_hash,
 previous_prompt:old.execution.prompt_version,counts,old_counts:oldCounts,status_transitions:transitions,known_answers:knownAnswers,old_known_answers:oldKnownAnswers,changes,unresolved,failed,calls:run.tasks.reduce((s,t)=>s+t.attempts.length,0),rows};
await mkdir('data/dev-refresh',{recursive:true});await writeFile('data/dev-refresh/'+id+'.comparison.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({run_id:id,prompt:report.prompt,counts,old_counts:oldCounts,status_transitions:transitions,known_answers:knownAnswers,old_known_answers:oldKnownAnswers,changes,unresolved,calls:report.calls,failed}));
