import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../../src/store.js';
import {importConversations,hash} from '../../src/domain.js';
const id='608e0e6b-72f4-4ea6-b34f-3c1bbaa04704',read=async p=>JSON.parse(await readFile(p,'utf8'));
const comparison=await read('data/reliability/data-chat-agreement.json'),run=await read(join('data/runs',id+'.json'));
const selected=comparison.all_non_agreements.filter(r=>r.criterion_id==='06'&&r.kind==='different_known_verdicts');assert.equal(selected.length,14);
const baseline=(await readFile('data/annotations/dev65.ai-provisional.jsonl','utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
const sources=importConversations(await read('data/dev/api-response.json')),store=new Store('data'),cases=[];
for(const c of selected){
 const task=run.tasks.find(t=>t.conversation_id===c.conversation_id),r=await store.read(task.evaluation_id),source=sources.find(s=>s.conversation_id===c.conversation_id);
 assert.deepEqual(r.conversation,source);assert.equal(r.configuration_hash,run.configuration_hash);
 cases.push({conversation_id:c.conversation_id,language:source.language,previously_reserved_holdout:c.human_holdout,
  evaluation_id:r.evaluation_id,transcript_hash:hash(source.transcript),data_chat:baseline.find(b=>b.conversation_id===c.conversation_id).criteria.find(k=>k.criterion_id==='06'),
  runtime:r.ai_review.criteria.find(k=>k.criterion_id==='06'),transcript:source.transcript});
}
const pack={run_id:id,notice:'Manual analytical review by the assistant against the PDF; neither AI side is official GT. No model call and no score/label rewrite.',
 source:'CQA_Chat_Quality_Checklist 1.pdf, all 3 pages',
 holdout_notice:'User explicitly requested all 14 cases. p1-en-008 was in holdout10; its content is now reviewed and cannot be claimed as blind for future prompt tuning. Original split stays unchanged.',cases};
const directory='data/reliability/criterion06-review';await mkdir(directory,{recursive:true});await writeFile(join(directory,'input-pack.json'),JSON.stringify(pack,null,2));
const subset=process.argv.slice(2);for(const c of cases.filter(c=>!subset.length||subset.includes(c.conversation_id))){
 console.log(`\nCASE ${c.conversation_id}; data_chat=${c.data_chat.value}; runtime=${c.runtime.value}; previous_holdout=${c.previously_reserved_holdout}`);
 console.log(`DATA_CHAT: ${c.data_chat.explanation}\nRUNTIME: ${c.runtime.explanation}`);
 for(const m of c.transcript)console.log(`${m.message_id} ${m.timestamp} ${m.speaker}: ${m.text}`);
}
