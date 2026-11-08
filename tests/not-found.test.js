import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.js';

test('unknown browser routes serve the 404 design while API errors remain JSON',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'cqa-404-'));
 const {server}=await createApp({directory,provider:{identity:{provider:'TEST',model:'TEST'},evaluate:async()=>{throw Error('No AI in 404 test');}},datasetUrl:'',devFile:join(directory,'no-dev'),config:{ready:false,provider:'TEST',model:'',missing:[]}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.address().port}`;
 for(const path of ['/missing/nested/page','/404','/404.html']){
  const response=await fetch(origin+path,{headers:{Accept:'text/html'}});assert.equal(response.status,404);assert.match(response.headers.get('content-type'),/text\/html/);
  const html=await response.text();assert.match(html,/aria-label="404"/);assert.match(html,/href="\/"/);assert.match(html,/href="\/#service"/);assert.doesNotMatch(html,/missing\/nested\/page/);
 }
 const head=await fetch(origin+'/missing/page',{method:'HEAD',headers:{Accept:'text/html'}});assert.equal(head.status,404);assert.equal(await head.text(),'');
 const api=await fetch(origin+'/api/not-real',{headers:{Accept:'text/html'}});assert.equal(api.status,404);assert.match(api.headers.get('content-type'),/application\/json/);assert.deepEqual(await api.json(),{error:'Не найдено.'});
 const style=await fetch(origin+'/glass.css');assert.equal(style.status,200);assert.match(await style.text(),/not-found-code/);
});
