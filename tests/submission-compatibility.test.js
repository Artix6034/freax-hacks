import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {submissionCompatibility,SUBMISSION_CRITERIA} from '../src/submission.js';
import {submissionCompatibility as browserCheck} from '../src/web/submission-compatibility.js';
import {createApp} from '../src/server.js';
import {main as batchCLI} from '../scripts/evaluate-batch.mjs';

const initial=JSON.parse(await readFile(new URL('../config/checklist.v1.json',import.meta.url),'utf8'));
test('submission compatibility keeps dynamic descriptions/weights and exposes all unsupported edits without mutation',()=>{
  assert.equal(submissionCompatibility,browserCheck);
  const c=structuredClone(initial);c.criteria[4].instruction='A different service rule';c.criteria[4].weight=19;
  assert.equal(submissionCompatibility(c).compatible,true);
  for(const [kind,edit,code] of [
    ['rename',x=>x.criteria[4].id='replacement','CRITERION_SET'],
    ['remove',x=>x.criteria.pop(),'CRITERION_SET'],
    ['add',x=>x.criteria.push({...x.criteria[4],id:'new'}),'CRITERION_SET'],
    ['duplicate',x=>x.criteria[4].id='01','CRITERION_SET'],
    ['type',x=>x.criteria[4].type='flag','TYPE'],
    ['scale',x=>x.criteria[5].scale=[{value:0},{value:2},{value:5}],'SCALE']
  ]){const draft=structuredClone(c);edit(draft);const snapshot=structuredClone(draft);const r=submissionCompatibility(draft);
    assert.equal(r.compatible,false,kind);assert.ok(r.issues.some(i=>i.code===code),kind);assert.deepEqual(draft,snapshot);}
  assert.deepEqual(SUBMISSION_CRITERIA.map(c=>c.code),['contact','discovery','identification','consultation','empathy','dialogue','closure','critical']);
});
test('unsupported N/A is a potential per-dialogue error, not rejection of an otherwise compatible checklist',()=>{
  const c=structuredClone(initial);c.criteria[4].allow_na=true;
  const r=submissionCompatibility(c);assert.equal(r.compatible,true);assert.deepEqual(r.warnings.map(i=>i.criterion_id),['05']);assert.match(r.warnings[0].message,/error/);
  c.criteria[4].allow_na=false;c.criteria[0].allow_na=true;c.criteria[0].na_channels=['voice call'];c.criteria[0].na_condition='recording_started_after_greeting';
  assert.equal(submissionCompatibility(c).warnings.length,0);
  delete c.criteria[0].na_channels;assert.equal(submissionCompatibility(c).warnings[0].code,'CONTACT_NA_SCOPE');
});
test('CLI preflight needs no model and rejects incompatible start before model configuration or dataset access',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'cqa-preflight-cli-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const c=structuredClone(initial);c.criteria.push({...structuredClone(c.criteria[4]),id:'new'});
 const file=join(directory,'checklist.json');await writeFile(file,JSON.stringify(c));
 const output=[],errors=[],io={out:x=>output.push(JSON.parse(x)),err:x=>errors.push(JSON.parse(x))};
 assert.equal(await batchCLI(['preflight','--checklist',file],io),2);assert.equal(output[0].compatible,false);assert.equal(errors.length,0);
 assert.equal(await batchCLI(['start','--checklist',file,'--dataset',join(directory,'absent.json'),'--subset','prod'],io),2);
 assert.match(errors[0].error,/--allow-incompatible/);
 assert.equal(await batchCLI(['preflight','--checklist','config/checklist.v1.json'],io),0);
});
test('HTTP serves the same browser preflight and still saves arbitrary dynamic criteria without an AI request',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cqa-preflight-'));let calls=0;
  const {server}=await createApp({directory,provider:{evaluate(){calls++;throw Error('No evaluation expected');}},referenceText:'',datasetUrl:'',devFile:join(directory,'none.json')});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(async()=>{await new Promise(ok=>server.close(ok));await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const asset=await fetch(base+'/submission-compatibility.js');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);
  assert.equal(await asset.text(),await readFile(new URL('../src/web/submission-compatibility.js',import.meta.url),'utf8'));
  const draft=structuredClone(initial);draft.criteria.push({...structuredClone(draft.criteria[4]),id:'custom'});
  const saved=await fetch(base+'/api/checklists',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)});
  assert.equal(saved.status,201);const version=await saved.json();assert.equal(version.criteria.length,9);assert.equal(submissionCompatibility(version).compatible,false);assert.equal(calls,0);
});
