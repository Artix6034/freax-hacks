// PROD10 only. Offline by default; paid evaluation requires explicit --run.
// Uses the active server provider, queue, validators and official exporter.
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.js';
import {EvaluationService} from '../src/service.js';
import {BatchManager} from '../src/batch.js';
import {providerConfig,createProvider,PROMPT_VERSION} from '../src/ai/provider.js';
import {SYSTEM_PROMPT} from '../src/ai/prompt.js';
import {SCHEMA_VERSION} from '../src/ai/schema.js';
import {hash,InputError,requireThat,validateChecklist} from '../src/domain.js';
import {submissionDataset,submissionCompatibility,SubmissionError} from '../src/submission.js';
import {datasetReady,importRemoteDataset} from '../src/datasets.js';
import {main as exportResults} from './export-results.mjs';
const json=async p=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readFile(p)));
const exists=async p=>{try{await access(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
export async function main(args=process.argv.slice(2),{cwd=process.cwd(),env=process.env,out=console.log,err=console.error,providerFactory=createProvider}={}){
 try{
  const opts={};
  for(let i=0;i<args.length;i++){
   const a=args[i];if(['--run','--resume','--retry-failed','--preflight'].includes(a)){requireThat(!opts[a],'Повторный параметр.');opts[a]=true;continue;}
   requireThat(['--dataset','--group-id','--checklist'].includes(a)&&args[i+1]&&!args[i+1].startsWith('--')&&!opts[a],'Неизвестный, повторный или незаполненный параметр.');opts[a]=args[++i];
  }
  requireThat(!opts['--dataset']||!opts['--group-id'],'Выберите файл или group_id.');
  requireThat(!(opts['--run']&&opts['--resume']),'Выберите --run или --resume.');
  requireThat(!opts['--retry-failed']||opts['--resume'],'Повтор сбоев разрешён только с --resume --retry-failed.');
  requireThat(!opts['--preflight']||!opts['--run']&&!opts['--resume'],'--preflight не запускает оценку.');
  const checklist=validateChecklist(await json(opts['--checklist']?resolve(cwd,opts['--checklist']):new URL('../config/checklist.organizer-2026-11-07.json',import.meta.url)));
  const compatibility=submissionCompatibility(checklist);requireThat(compatibility.compatible,'Чек-лист несовместим с официальным приложением Results.');
  const config=providerConfig(env),directory=resolve(cwd,'data/prod'),evaluationDirectory=join(directory,'evaluations'),launchFile=join(directory,'launch.json'),sourceFile=join(directory,'source.json');
  const readiness={prompt_version:PROMPT_VERSION,prompt_hash:hash(SYSTEM_PROMPT),schema_version:SCHEMA_VERSION,checklist_hash:hash(checklist),model:config.model||null,model_configured:config.ready,dataset_api_configured:datasetReady(env.CQA_DATASET_URL),checklist_compatible:true,output:'results/prod/results.json',model_calls:0};
  let input;
  if(opts['--resume']){
   requireThat(!opts['--dataset']&&!opts['--group-id'],'Продолжение использует сохранённый исходный набор.');
   requireThat(await exists(launchFile),'Нет сохранённого PROD-прогона для продолжения.');input=await json(sourceFile);
  }else if(opts['--dataset'])input=await json(resolve(cwd,opts['--dataset']));
  else if(opts['--group-id']){
   requireThat(opts['--run'],'Загрузка API выполняется с явным --run; офлайн-проверка не обращается к сети.');
   input=await importRemoteDataset(env.CQA_DATASET_URL,opts['--group-id']);
  }
  if(!input){requireThat(!opts['--run'],'Нужен --dataset <путь> или выданный организаторами --group-id.');out(JSON.stringify({status:config.ready?'ready_for_control_data':'model_not_configured',...readiness,waiting_for:'10 organizer control chats',submission_created:false}));return config.ready?0:2;}
  const conversations=submissionDataset(input,'prod'); // Count, unique IDs and chat-only BEFORE provider/calls.
  requireThat(conversations.every(c=>c.transcript.some(m=>m.speaker==='operator')),'В контрольном наборе есть чат без реплик оператора.');
  if(!opts['--run']&&!opts['--resume']){out(JSON.stringify({status:config.ready?'ready_to_evaluate':'model_not_configured',...readiness,records:10,dataset_hash:hash(conversations),submission_created:false}));return config.ready?0:2;}
  requireThat(config.ready,'AI не настроен; проверьте локальный .env.');
  if(opts['--run'])requireThat(!await exists(launchFile),'PROD уже запущен. Используйте --resume; готовые попытки не повторяются.');
  const provider=providerFactory(config),store=new Store(evaluationDirectory);await store.init();
  // No company FAQ/reference files are loaded, even if one is set in the environment.
  const service=new EvaluationService(store,provider,'','organizer-checklist-only');
  const manager=await new BatchManager(store,service).init();let launch;
  if(opts['--resume']){
   launch=await json(launchFile);requireThat(launch.dataset_hash===hash(conversations),'Сохранённый PROD-набор изменился.');
  }else{
   await mkdir(directory,{recursive:true});
   const run=await manager.create(conversations,checklist,{subset:'prod',concurrency:4});
   launch={run_id:run.run_id,dataset_hash:hash(conversations),created_at:new Date().toISOString(),prompt_version:PROMPT_VERSION,prompt_hash:hash(SYSTEM_PROMPT),checklist_hash:hash(checklist),evaluation_directory:evaluationDirectory};
   await writeFile(sourceFile,JSON.stringify(input,null,2)+'\n',{flag:'wx'});
   await writeFile(launchFile,JSON.stringify(launch,null,2)+'\n',{flag:'wx'});
  }
  out(JSON.stringify({status:'evaluating',run_id:launch.run_id,records:10,prompt_version:PROMPT_VERSION,directory:evaluationDirectory,retry_failed:Boolean(opts['--retry-failed'])}));
  const started=await manager.start(launch.run_id,{retryFailed:Boolean(opts['--retry-failed'])});
  const stop=()=>{manager.pause(launch.run_id).catch(()=>{});};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);let run;
  try{run=await started.promise;}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  requireThat(run.finished===10,'PROD-прогон не завершён; продолжите через --resume.');
  const exportArgs=['--subset','prod','--dataset',sourceFile,'--evaluations-dir',evaluationDirectory,'--run-id',launch.run_id];
  let code=await exportResults(['readiness',...exportArgs],{cwd,out,err});if(code!==0)return code;
  code=await exportResults(['export',...exportArgs],{cwd,out,err});if(code!==0)return code;
  code=await exportResults(['validate','--subset','prod','--dataset',sourceFile,'--input','results/prod/results.json','--checklist',opts['--checklist']?resolve(cwd,opts['--checklist']):fileURLToPath(new URL('../config/checklist.organizer-2026-11-07.json',import.meta.url))],{cwd,out,err});
  if(code!==0)return code;
  out(JSON.stringify({status:run.counts.failed||run.counts.partial?'exported_with_errors':'prod_ready',run_id:launch.run_id,records:10,counts:run.counts,output:'results/prod/results.json',published:false}));
  return run.counts.failed||run.counts.partial?2:0;
 }catch(e){err(JSON.stringify({status:'blocked',code:e.code??'INPUT_ERROR',error:e instanceof InputError||e instanceof SubmissionError?e.message:'Не удалось подготовить PROD; исходные данные и готовые попытки сохранены.'}));return 2;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
