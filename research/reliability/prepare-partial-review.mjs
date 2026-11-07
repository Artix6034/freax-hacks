// Offline analytical review. Never changes source evaluations, labels, runtime reference or submission files.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {hash} from '../../src/domain.js';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const manifest=await read('data/submissions/dev.manifest.json');
const assessments=await read('research/reliability/partial04-assessments.json');
assert.equal(assessments.cases.length,12);assert.equal(new Set(assessments.cases.map(c=>c.id)).size,12);
const cases=[];
for(const selected of manifest.selected_evaluations){
 const r=await read(`data/${selected.evaluation_id}.json`);if(r.status!=='partial')continue;
 const a=assessments.cases.find(a=>a.id===selected.conversation_id);assert.ok(a,selected.conversation_id);
 assert.equal(r.checklist_hash,manifest.checklist_hash);assert.equal(r.configuration_hash,manifest.configuration_hash);
 assert.equal(r.conversation_hash,hash(r.conversation));assert.equal(r.prompt_version,'cqa-facts-1.3-dialogue-scale-grounding');
 const ids=new Map(r.conversation.transcript.map(m=>[m.message_id,m]));assert.ok(a.evidence_ids.every(id=>ids.has(id)));
 assert.ok(r.ai_review.criteria.some(c=>c.criterion_id==='04'&&c.status==='unresolved'));
 assert.ok(a.proposed_value===null||(a.action==='user_working_label'&&a.proposed_value===10&&a.id==='p4-ru-002')); // Explicit user decision after review, not independent GT.
 cases.push({...a,evaluation_id:r.evaluation_id,conversation_hash:r.conversation_hash,
  evidence:a.evidence_ids.map(id=>ids.get(id)),unresolved:r.ai_review.criteria.filter(c=>c.status==='unresolved')});
}
assert.equal(cases.length,12);
const counts=Object.fromEntries([...new Set(cases.map(c=>c.action))].map(action=>[action,cases.filter(c=>c.action===action).length]));
const report={authority:assessments.authority,source_policy:assessments.source_policy,run_id:manifest.run_id,configuration_hash:manifest.configuration_hash,counts,
 production_scores_changed:false,model_calls:0,reference_loaded_into_runtime:false,cases};
await mkdir('data/partial-review',{recursive:true});await writeFile('data/partial-review/assessment.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({reviewed:cases.length,counts,model_calls:0,production_scores_changed:false}));
