import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const id='608e0e6b-72f4-4ea6-b34f-3c1bbaa04704',run=JSON.parse(await readFile(join('data/runs',id+'.json'),'utf8'));
const directory=resolve('data/reliability');await mkdir(directory,{recursive:true});const file=join(directory,'continuation-check.json');
if(process.argv.includes('--paused')){
 assert.equal(run.status,'paused');const completed=run.tasks.filter(t=>t.status==='completed');assert.equal(completed.length,6);
 assert.ok(run.tasks.every(t=>t.attempts.length<=1));
 assert.equal(run.tasks.find(t=>t.conversation_id==='p1-ru-003').evaluation_id,'333f9870-c326-4ae6-b115-dfc5539b48fc');
 assert.equal(run.tasks.find(t=>t.conversation_id==='p1-ru-004').evaluation_id,'a87df1db-bde0-480e-806b-652c68e60c55');
 await writeFile(file,JSON.stringify({run_id:id,paused_at:new Date().toISOString(),completed:completed.map(t=>({conversation_id:t.conversation_id,evaluation_id:t.evaluation_id})),pending:run.tasks.filter(t=>t.status==='pending').length,
  notice:'Windows storage interruption recovered; two already completed outputs reused. A subsequent normal pause drained four new calls. Each of the six dialogues has exactly one attempt.'},null,2));
 console.log('Paused: six completed outputs, one attempt each; 59 pending.');
}else{
 const proof=JSON.parse(await readFile(file,'utf8'));assert.equal(run.status,'completed');
 for(const old of proof.completed){const task=run.tasks.find(t=>t.conversation_id===old.conversation_id);assert.equal(task.evaluation_id,old.evaluation_id);assert.equal(task.attempts.length,1);}
 proof.final={verified_at:new Date().toISOString(),total:run.tasks.length,attempts:run.tasks.reduce((n,t)=>n+t.attempts.length,0),completed_outputs_reused:proof.completed.length};
 await writeFile(file,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof.final));
}
