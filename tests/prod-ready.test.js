// Synthetic mechanics only; never actual PROD records or quality labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {main} from '../scripts/prepare-prod.mjs';
import {factsFixture} from './fixtures/dialog-facts.js';
const env={AI_PROVIDER:'local',AI_BASE_URL:'http://127.0.0.1:1/v1',AI_MODEL:'ARTIFICIAL-PROD-FORMAT-TEST'};
const dataset=n=>Array.from({length:n},(_,i)=>({conversation_id:`artificial-prod-${i+1}`,channel:'agent chat',language:'RU',audio_url:null,transcript:[{speaker:'client',timestamp:'00:00',text:'ИСКУССТВЕННЫЙ ТЕСТ: повторите 23.'},{speaker:'operator',timestamp:'00:01',text:'Здравствуйте! Я ТЕСТ. 23.'}]}));
async function temp(t){const dir=await mkdtemp(join(tmpdir(),'cqa-prod-ready-'));t.after(async()=>{assert.ok(dir.startsWith(join(tmpdir(),'cqa-prod-ready-')));await rm(dir,{recursive:true,force:true});});return dir;}
test('PROD readiness without control data makes zero calls and creates no submission',async t=>{
 const cwd=await temp(t),output=[];let created=0;
 const code=await main(['--preflight'],{cwd,env,out:s=>output.push(JSON.parse(s)),err:assert.fail,providerFactory:()=>{created++;throw Error('must not run');}});
 assert.equal(code,0);assert.equal(created,0);assert.equal(output[0].status,'ready_for_control_data');assert.equal(output[0].submission_created,false);
 await assert.rejects(access(join(cwd,'results/prod/results.json')));
});
test('wrong count, DEV65, duplicate IDs and voice are rejected before constructing a paid provider',async t=>{
 const cwd=await temp(t);let created=0;
 const inputs=[dataset(9),dataset(65),dataset(10),dataset(10)];inputs[2][9].conversation_id=inputs[2][0].conversation_id;
 inputs[3][0].channel='voice call';inputs[3][0].transcript.forEach((m,i)=>m.timestamp=`2026-11-08T00:00:0${i}Z`);
 for(let i=0;i<inputs.length;i++){
  const file=join(cwd,`source-${i}.json`);await writeFile(file,JSON.stringify(inputs[i]));const errors=[];
  assert.equal(await main(['--dataset',file,'--run'],{cwd,env,out:()=>{},err:s=>errors.push(JSON.parse(s)),providerFactory:()=>{created++;throw Error('must not run');}}),2);
  assert.ok(['DATASET_COUNT','DUPLICATE_SOURCE_ID','DATASET_CHANNELS'].includes(errors[0].code));
 }
 assert.equal(created,0);await assert.rejects(access(join(cwd,'results/prod/results.json')));
});
test('valid PROD10 offline preflight preserves source and does not start evaluation',async t=>{
 const cwd=await temp(t),file=join(cwd,'input.json'),text=JSON.stringify(dataset(10)),output=[];await writeFile(file,text);
 assert.equal(await main(['--dataset',file],{cwd,env,out:s=>output.push(JSON.parse(s)),err:assert.fail,providerFactory:()=>{throw Error('must not run');}}),0);
 assert.equal(output[0].status,'ready_to_evaluate');assert.equal(output[0].records,10);assert.equal(await readFile(file,'utf8'),text);
 await assert.rejects(access(join(cwd,'data/prod/launch.json')));
});
test('PROD pipeline exports NA as null and partial as error, then resume never rebills finished attempts',async t=>{
 const cwd=await temp(t),file=join(cwd,'input.json');await writeFile(file,JSON.stringify(dataset(10)));let calls=0;
 const providerFactory=()=>({identity:{provider:'local',model:env.AI_MODEL,requested_model:env.AI_MODEL},async evaluate(conversation,checklist){
  calls++;const partial=conversation.conversation_id==='artificial-prod-10';
  const review={criteria:checklist.criteria.map(c=>{
   const value=c.id==='02'||c.id==='03'?'na':c.id==='04'?20:c.id==='06'?10:c.id==='07'||c.id==='08'?'no':'yes';
   if(c.id==='04'&&partial)return {criterion_id:c.id,status:'unresolved',value:null,explanation:'ARTIFICIAL: decisive evidence missing.',missing_information:['ARTIFICIAL unavailable fact.'],na_reason:'',na_condition:'',evidence:[],checked_ranges:[]};
   return {criterion_id:c.id,status:'resolved',value,explanation:'ARTIFICIAL FORMAT TEST, not a quality verdict.',missing_information:[],na_reason:value==='na'?'ARTIFICIAL applicability.':'',na_condition:'',evidence:c.id==='08'?[]:[{message_id:'m0002',quote:'Здравствуйте! Я ТЕСТ.'}],checked_ranges:c.id==='08'?[{from_message_id:'m0001',to_message_id:'m0002',expected_action:'ARTIFICIAL full range.'}]:[]};
  })};
  return {review,dialogFacts:factsFixture(conversation),metadata:{provider:'local',model:env.AI_MODEL,requested_model:env.AI_MODEL,calls:[{provider:'local',requested_model:env.AI_MODEL,returned_model:env.AI_MODEL}],attempts:1}};
 }});
 const output=[],errors=[],options={cwd,env,out:s=>output.push(JSON.parse(s)),err:s=>errors.push(JSON.parse(s)),providerFactory};
 assert.equal(await main(['--dataset',file,'--run'],options),2);assert.equal(calls,10);assert.deepEqual(errors,[]);
 const doc=JSON.parse(await readFile(join(cwd,'results/prod/results.json'),'utf8'));assert.equal(doc.results.length,10);
 assert.equal(doc.results[0].criteria.find(c=>c.criterion_id==='discovery').value,null);
 assert.equal(doc.results[9].status,'error');assert.deepEqual(doc.results[9].criteria,[]);assert.equal(doc.results[9].score,null);
 assert.equal(output.at(-1).status,'exported_with_errors');
 assert.equal(await main(['--dataset',file,'--run'],options),2);assert.equal(calls,10);
 errors.length=0;assert.equal(await main(['--resume'],options),2);assert.equal(calls,10);assert.deepEqual(errors,[]);
});
