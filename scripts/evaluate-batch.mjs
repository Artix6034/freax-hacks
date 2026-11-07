import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.js';
import {EvaluationService} from '../src/service.js';
import {createProvider,providerConfig} from '../src/ai/provider.js';
import {BatchManager} from '../src/batch.js';
import {requireThat,InputError} from '../src/domain.js';

export async function main(args=process.argv.slice(2),{out=console.log,err=console.error}={}){
 try{
  const [command,...rest]=args,opts={};
  if(!command||command==='--help'){
   out('start --dataset <API.json> --checklist <checklist.json> --subset dev|prod [--directory data] [--concurrency 2]\nresume --run-id <UUID> [--directory data] [--retry-failed]\nstatus [--run-id <UUID>] [--directory data]\nResume skips finished attempts. --retry-failed explicitly creates new paid attempts for failures. Partial verdicts stay partial.');return 0;
  }
  requireThat(['start','resume','status'].includes(command),'Команды: start, resume, status.');
  const names=new Set(['dataset','checklist','subset','directory','concurrency','run-id']);
  for(let i=0;i<rest.length;i++){
   const name=rest[i].slice(2);if(rest[i]==='--retry-failed'){opts.retry=true;continue;}
   requireThat(rest[i].startsWith('--')&&names.has(name)&&rest[i+1]&&!rest[i+1].startsWith('--')&&!Object.hasOwn(opts,name),'Неизвестный или повторный параметр.');opts[name]=rest[++i];
  }
  requireThat(!opts.retry||command==='resume','--retry-failed применяется только к resume.');
  const store=new Store(resolve(opts.directory||'data'));await store.init();
  const reference=process.env.CQA_REFERENCE_FILE?await readFile(resolve(process.env.CQA_REFERENCE_FILE),'utf8'):'';
  const config=providerConfig(),service=new EvaluationService(store,createProvider(config),reference,process.env.CQA_REFERENCE_VERSION||'');
  const manager=await new BatchManager(store,service).init();
  if(command==='status'){out(JSON.stringify(opts['run-id']?await manager.get(opts['run-id']):await manager.list()));return 0;}
  requireThat(config.ready,'AI не настроен. Проверьте настройки сервера.');
  let id=opts['run-id'];
  if(command==='start'){
   requireThat(opts.dataset&&opts.checklist&&['dev','prod'].includes(opts.subset),'Нужны dataset, checklist и subset.');
   const input=JSON.parse(await readFile(resolve(opts.dataset),'utf8')),checklist=JSON.parse(await readFile(resolve(opts.checklist),'utf8'));
   const run=await manager.create(input,checklist,{subset:opts.subset,concurrency:Number(opts.concurrency??2)});id=run.run_id;
   out(JSON.stringify({event:'created',run_id:id,total:run.total,configuration_hash:run.configuration_hash}));
  }else requireThat(id,'Укажите --run-id.');
  const started=await manager.start(id,{retryFailed:opts.retry??false});
  let reported='';const timer=setInterval(async()=>{try{const r=await manager.get(id),state=JSON.stringify({event:'progress',run_id:id,status:r.status,finished:r.finished,total:r.total,counts:r.counts});if(state!==reported){reported=state;out(state);}}catch{}},1000);
  const stop=()=>{manager.pause(id).catch(()=>{});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{const result=await started.promise;out(JSON.stringify({event:'finished',...result}));return result.counts.failed?2:0;}
  finally{clearInterval(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
 }catch(e){err(JSON.stringify({status:'blocked',error:e instanceof InputError?e.message:'Не удалось подготовить или выполнить пакетный прогон.'}));return 2;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
