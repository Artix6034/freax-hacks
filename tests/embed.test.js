import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp,parseEmbedOrigins} from '../src/server.js';
import {providerConfig} from '../src/ai/provider.js';
import {BRIDGE,acceptsParent,connectEmbed} from '../src/web/embed.js';
test('embed allows only exact HTTPS origins and local development origins',()=>{
  assert.deepEqual(parseEmbedOrigins('https://crm.example, https://crm.example/, http://127.0.0.1:3002'),['https://crm.example','http://127.0.0.1:3002']);
  for(const value of ['*','http://crm.example','https://u:p@crm.example','https://crm.example/path','https://crm.example/?token=x',"https://crm.example/#x"])assert.throws(()=>parseEmbedOrigins(value));
});
test('bridge rejects foreign windows/origins and cannot start paid evaluation',async()=>{
  let listener,loads=0;const sent=[],parent={postMessage:(data,origin)=>sent.push({data,origin})};
  const win={parent,addEventListener:(_,fn)=>listener=fn};
  const notify=connectEmbed({window:win,origins:['https://crm.example'],loadConversation:async()=>loads++,onError:assert.fail});
  const event=(origin,type,source=parent)=>({origin,source,data:{channel:BRIDGE,type,conversation:{}}});
  for(const e of [event('https://evil.example','hello'),event('https://crm.example','hello',{})]){assert.equal(acceptsParent(e,parent,['https://crm.example']),false);await listener(e);}
  await listener(event('https://crm.example','load-conversation'));assert.equal(loads,0);
  await listener(event('https://crm.example','hello'));assert.equal(sent[0].data.type,'ready');
  await listener(event('https://crm.example','evaluate'));assert.equal(loads,0);
  await listener(event('https://crm.example','load-conversation'));assert.equal(loads,1);
  notify({evaluation_id:'test',conversation:{conversation_id:'test',transcript:['PRIVATE']},checklist:{version:2},status:'partial',final_score:{total:null,gross_error:null},ai_metadata:{secret:'PRIVATE'}});
  assert.equal(JSON.stringify(sent).includes('PRIVATE'),false);assert.ok(sent.every(m=>m.origin==='https://crm.example'));
});
test('server supports HTTPS proxy origin, exact frame ancestors, health and private static boundary',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cqa-embed-'));
  const {server}=await createApp({directory,config:providerConfig({}),referenceText:'',embedOrigins:'https://crm.example',publicOrigin:'https://freax.example'});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const health=await fetch(base+'/healthz');assert.equal((await health.json()).status,'ok');assert.match(health.headers.get('content-security-policy'),/frame-ancestors 'self' https:\/\/crm.example/);
    const request=origin=>fetch(base+'/api/import',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
    assert.equal((await request('https://freax.example')).status,400);assert.equal((await request('https://evil.example')).status,403);
    for(const path of ['/.env','/.env.brev','/data/checklists.json'])assert.equal((await fetch(base+path)).status,404);
    assert.equal((await fetch(base+'/embed.js')).status,200);assert.equal((await fetch(base+'/assets/freax.svg')).status,200);
  }finally{await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});
