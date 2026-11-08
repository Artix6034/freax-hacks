// Fresh production store gets organizer rules, existing customized stores remain unchanged.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Store} from '../src/store.js';
import {validateChecklist} from '../src/domain.js';
import {createApp} from '../src/server.js';
const directory=resolve(process.env.CQA_DATA_DIR||'data');
const store=new Store(directory);await store.init();
try{await store.read('checklists');}catch(e){
  if(e.status!==404)throw e;
  const templates=await Promise.all(['checklist.v1.json','checklist.organizer-2026-11-07.json'].map(async name=>validateChecklist(JSON.parse(await readFile(new URL(`../config/${name}`,import.meta.url),'utf8')))));
  await store.write('checklists',templates);
}
const {server,batches}=await createApp({directory,referenceText:''}); // Organizer/transcript evidence only.
const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
server.listen(port,host,()=>console.log(`Freax listening on ${host}:${port}`));
let stopping=false;
async function shutdown(){
  if(stopping)return;stopping=true;
  const deadline=setTimeout(()=>process.exit(1),125000);deadline.unref();
  const closed=new Promise(ok=>server.close(ok)),active=batches.active;
  if(active){await batches.pause(active.id);await active.promise;}
  await closed;clearTimeout(deadline);process.exit(0);
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
