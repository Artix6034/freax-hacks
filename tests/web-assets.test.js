import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.js';

test('HTML and all transitive module/style/image dependencies are served by the real backend',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'cqa-web-assets-'));
 const {server}=await createApp({directory,provider:{identity:{provider:'TEST',model:'TEST'},evaluate:async()=>{throw Error('No AI calls in asset test');}},datasetUrl:'',devFile:join(directory,'no-dev'),config:{ready:false,provider:'TEST',model:'',missing:[]}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.address().port}`,queue=['/','/guide.html'],seen=new Set();
 while(queue.length){
  const path=queue.shift();if(seen.has(path))continue;seen.add(path);
  const response=await fetch(origin+path);assert.equal(response.status,200,path);
  const type=response.headers.get('content-type');
  if(path.endsWith('.png')){assert.equal(type,'image/png');assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0,8)],[137,80,78,71,13,10,26,10]);continue;}
  const text=await response.text();
  if(path==='/'||path.endsWith('.html')){
   assert.match(type,/text\/html/);
   for(const [,relative] of text.matchAll(/(?:src|href)="(\.\/[^\"]+)"/g))queue.push(new URL(relative,origin+path).pathname);
  }else if(path.endsWith('.js')){
   assert.match(type,/javascript/);
   for(const [,relative] of text.matchAll(/(?:from\s*|import\s*)['"](\.\/[^'"]+)['"]/g))queue.push(new URL(relative,origin+path).pathname);
  }else if(path.endsWith('.ttf')){assert.equal(type,'font/ttf');assert.ok(text.length>10000);}
  else{assert.match(type,/text\/css/);for(const [,relative] of text.matchAll(/url\(['"]?(\.\/[^)'"]+)['"]?\)/g))queue.push(new URL(relative,origin+path).pathname);}
 }
 assert.ok(seen.has('/components.js'));assert.ok(seen.has('/halftone.js'));assert.ok(seen.has('/ui-model.js'));
 assert.ok(seen.has('/ui-widgets.js'));assert.ok(seen.has('/ui-widgets.css'));assert.ok(seen.has('/examples.js'));assert.ok(seen.has('/guide.html'));
});
