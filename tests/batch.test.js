import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {EvaluationService} from '../src/service.js';
import {BatchManager} from '../src/batch.js';
import {createApp} from '../src/server.js';

const checklist=JSON.parse(await readFile(new URL('../config/checklist.v1.json',import.meta.url),'utf8'));
const source=i=>({conversation_id:`TEST-BATCH-${i}`,channel:'agent chat',language:'RU',transcript:[
 {speaker:'client',timestamp:'00:00',text:'ИСКУССТВЕННЫЙ ТЕСТ: вопрос.'},
 {speaker:'operator',timestamp:'00:01',text:'Здравствуйте! Я Анна. ИСКУССТВЕННЫЙ ТЕСТ: ответ.'}]});
const review=c=>({criteria:checklist.criteria.map(k=>({criterion_id:k.id,status:'resolved',value:k.type==='flag'?'no':k.type==='scale'?k.scale.at(-1).value:'yes',
 explanation:'ARTIFICIAL TEST ONLY',evidence:k.type==='flag'?[]:[{message_id:'m0002',quote:'Здравствуйте! Я Анна.'}],
 checked_ranges:k.type==='flag'?[{from_message_id:'m0001',to_message_id:'m0002',expected_action:'ARTIFICIAL TEST ONLY'}]:[],na_reason:'',na_condition:'',missing_information:[]}))});
async function setup(t,options={}){
 const directory=await mkdtemp(join(tmpdir(),'cqa-batch-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=new Store(directory);await store.init();let calls=0,fail=options.fail;
 const provider={identity:{provider:'local',model:'TEST ONLY',prompt_version:'TEST-v1',prompt_hash:'TEST HASH'},async evaluate(c){calls++;if(options.wait)await options.wait(c);if(fail&&c.conversation_id==='TEST-BATCH-1')throw Error('ARTIFICIAL failure');return {review:review(c),metadata:{provider:'local',model:'TEST ONLY'}};}};
 const service=new EvaluationService(store,provider),manager=await new BatchManager(store,service).init();
 return {store,service,manager,provider,get calls(){return calls;},setFail(v){fail=v;}};
}
test('batch resumes without rebilling finished/failed attempts; explicit retry preserves every attempt',async t=>{
 const x=await setup(t,{fail:true}),r=await x.manager.create([source(0),source(1),source(2)],checklist);
 const done=await (await x.manager.start(r.run_id)).promise;assert.deepEqual(done.counts,{pending:0,running:0,completed:2,partial:0,failed:1});assert.equal(x.calls,3);
 await (await x.manager.start(r.run_id)).promise;assert.equal(x.calls,3);
 x.setFail(false);const retried=await (await x.manager.start(r.run_id,{retryFailed:true})).promise;assert.equal(x.calls,4);assert.equal(retried.counts.failed,0);
 assert.equal(retried.tasks[1].attempts.length,2);assert.equal(retried.tasks[1].attempts[0].status,'failed');
 const records=await x.store.list();assert.equal(records.length,4);assert.ok(records.every(e=>e.run_id===r.run_id&&e.configuration_hash===r.configuration_hash));
});
test('pause drains in-flight request; new manager continues only pending work and rejects changed configuration',async t=>{
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const x=await setup(t,{wait:async()=>{entered();await gate;}}),run=await x.manager.create([source(0),source(1),source(2)],checklist,{concurrency:1});
 const active=await x.manager.start(run.run_id);await started;await x.manager.pause(run.run_id);release();
 const paused=await active.promise;assert.equal(paused.status,'paused');assert.equal(x.calls,1);
 x.provider.identity.prompt_version='TEST-v2';await assert.rejects(()=>x.manager.start(run.run_id),/изменились/);assert.equal(x.calls,1);
 x.provider.identity.prompt_version='TEST-v1';const next=await new BatchManager(x.store,x.service).init();const done=await(await next.start(run.run_id)).promise;
 assert.equal(done.counts.completed,3);assert.equal(x.calls,3);
});
test('interrupted manifest adopts saved completed result and preserves unknown in-flight attempt as failure',async t=>{
 const x=await setup(t),created=await x.manager.create([source(0),source(1)],checklist),run=await x.manager.runs.read(created.run_id);
 const record=await x.service.evaluate(source(0),checklist,{runId:run.run_id});
 Object.assign(run.tasks[0],{status:'running',evaluation_id:record.evaluation_id,attempts:[{evaluation_id:record.evaluation_id,status:'running'}]});
 const interrupted=structuredClone(record);interrupted.evaluation_id=crypto.randomUUID();interrupted.status='running';interrupted.conversation=source(1);
 await x.store.write(interrupted.evaluation_id,interrupted);
 Object.assign(run.tasks[1],{status:'running',evaluation_id:interrupted.evaluation_id,attempts:[{evaluation_id:interrupted.evaluation_id,status:'running'}]});
 await x.manager.runs.write(run.run_id,run);const done=await(await x.manager.start(run.run_id)).promise;
 assert.equal(x.calls,1);assert.equal(done.counts.completed,1);assert.equal(done.counts.failed,1);assert.equal((await x.store.read(interrupted.evaluation_id)).status,'failed');
});
test('two managers cannot run the same workspace concurrently',async t=>{
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const x=await setup(t,{wait:async()=>{entered();await gate;}}),r=await x.manager.create([source(0)],checklist);
 const a=await x.manager.start(r.run_id);await started;
 const other=await new BatchManager(x.store,x.service).init();
 try{await assert.rejects(()=>other.start(r.run_id),/Уже выполняется/);}finally{release();await a.promise;}
});
test('four workers survive transient manifest rename locks without orphan tasks or duplicate model calls',async t=>{
 const x=await setup(t),r=await x.manager.create([source(0),source(1),source(2),source(3)],checklist,{concurrency:4});let locked=0;
 x.manager.runs.renameFile=async(from,to)=>{if(locked++<2)throw Object.assign(Error('TEST Windows reader lock'),{code:'EPERM'});return rename(from,to);};
 const result=await(await x.manager.start(r.run_id)).promise;assert.equal(result.counts.completed,4);assert.equal(x.calls,4);
 assert.ok(result.tasks.every(t=>t.evaluation_id&&t.attempts.length===1));
 await(await x.manager.start(r.run_id)).promise;assert.equal(x.calls,4);
});
test('HTTP exposes live execution version, persists batch progress and scopes history by run',async t=>{
 const x=await setup(t),{server,batches}=await createApp({directory:x.store.directory,provider:x.provider,referenceText:''});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`,status=await(await fetch(base+'/api/status')).json();assert.ok(status.prompt_version&&status.schema_version&&status.prompt_hash);
 const response=await fetch(base+'/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversations:[source(0),source(1)],checklist_id:checklist.checklist_id,checklist_version:1,subset:'prod'})});
 assert.equal(response.status,202);const run=await response.json();if(batches.active)await batches.active.promise;
 const done=await(await fetch(base+`/api/runs/${run.run_id}`)).json();assert.equal(done.counts.completed,2);
 const history=await(await fetch(base+`/api/evaluations?run_id=${run.run_id}`)).json();assert.equal(history.length,2);assert.ok(history.every(r=>r.run_id===run.run_id&&r.configuration_hash));
 const invalid=await fetch(base+`/api/runs/${run.run_id}/submission`);assert.equal(invalid.status,400); // PROD needs exactly ten.
});
