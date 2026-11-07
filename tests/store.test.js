import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,rename,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';

test('transient Windows destination lock retries storage, keeps old JSON readable and atomically commits',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cqa-store-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const id=randomUUID(),base=new Store(dir);await base.write(id,{value:'old'});let calls=0;
 const store=new Store(dir,{renameFile:async(from,to)=>{calls++;assert.deepEqual(JSON.parse(await readFile(to,'utf8')),{value:'old'});if(calls<3)throw Object.assign(Error('TEST lock'),{code:'EPERM'});return rename(from,to);}});
 await store.write(id,{value:'new'});assert.equal(calls,3);assert.deepEqual(await store.read(id),{value:'new'});assert.ok((await readdir(dir)).every(n=>!n.endsWith('.tmp')));
});
test('permanent storage failure preserves previous good record and cleans temporary files',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cqa-store-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const id=randomUUID(),base=new Store(dir);await base.write(id,{value:'old'});let calls=0;
 const store=new Store(dir,{renameFile:async()=>{calls++;throw Object.assign(Error('TEST permission'),{code:'EPERM'});}});
 await assert.rejects(()=>store.write(id,{value:'new'}),/TEST permission/);assert.equal(calls,8);assert.deepEqual(await base.read(id),{value:'old'});assert.ok((await readdir(dir)).every(n=>!n.endsWith('.tmp')));
});
