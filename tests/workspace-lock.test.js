import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {acquireWorkspace} from '../src/batch.js';
function fixture(errors){const ports=[];let closed=0;return {ports,get closed(){return closed;},factory(){const server=new EventEmitter();
 server.listen=(port,host,ok)=>{assert.equal(host,'127.0.0.1');ports.push(port);const code=errors[ports.length-1];queueMicrotask(()=>code?server.emit('error',{code}):ok());};
 server.close=ok=>{closed++;ok();};return server;}};}
test('workspace lock skips denied ports in a deterministic order and releases the acquired socket',async()=>{
 const a=fixture(['EACCES','EACCES']),b=fixture(['EACCES','EACCES']);
 const releaseA=await acquireWorkspace('test-lock-directory',{serverFactory:()=>a.factory()});
 const releaseB=await acquireWorkspace('test-lock-directory',{serverFactory:()=>b.factory()});
 assert.deepEqual(a.ports,b.ports);assert.equal(a.ports.length,3);await releaseA();await releaseB();assert.equal(a.closed,3);
});
test('occupied workspace port is never skipped, including after a denied port',async()=>{
 for(const codes of [['EADDRINUSE'],['EACCES','EADDRINUSE']]){const f=fixture(codes);
  await assert.rejects(()=>acquireWorkspace('test-lock-directory',{serverFactory:()=>f.factory()}),e=>e.code==='WORKSPACE_BUSY'&&e.status===409);
  assert.equal(f.ports.length,codes.length);}
});
test('workspace lock bounds denied-port attempts and does not retry other listen errors',async()=>{
 const denied=fixture(Array(16).fill('EACCES'));await assert.rejects(()=>acquireWorkspace('test-lock-directory',{serverFactory:()=>denied.factory()}),e=>e.code==='LOCK_PORT_DENIED');assert.equal(denied.ports.length,16);
 const other=fixture(['EINVAL']);await assert.rejects(()=>acquireWorkspace('test-lock-directory',{serverFactory:()=>other.factory()}),e=>e.code==='LOCK_LISTEN_ERROR');assert.equal(other.ports.length,1);
});
