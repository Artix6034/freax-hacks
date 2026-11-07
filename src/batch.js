import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {createServer} from 'node:net';
import {Store} from './store.js';
import {hash,requireThat,InputError,importConversations,validateChecklist} from './domain.js';

const terminal=new Set(['completed','partial','failed']);
export function summarizeRun(run){
  const counts=Object.fromEntries(['pending','running','completed','partial','failed'].map(s=>[s,run.tasks.filter(t=>t.status===s).length]));
  return {run_id:run.run_id,subset:run.subset,status:run.status,created_at:run.created_at,updated_at:run.updated_at,total:run.tasks.length,
    finished:counts.completed+counts.partial+counts.failed,counts,configuration_hash:run.configuration_hash,execution:run.execution,
    dataset_hash:run.dataset_hash,error:run.error??null,tasks:run.tasks.map(({conversation,...t})=>t)};
}

// A local OS socket is a cross-process mutex. It is released by the OS even on a
// hard crash, so resuming does not rely on deleting potentially live PID locks.
export async function acquireWorkspace(directory,{serverFactory=createServer}={}){
  const key=resolve(directory).toLowerCase();
  // Windows can reserve TCP ranges (EACCES). Every process tries the same
  // ordered ports. An occupied port is NEVER skipped: it may be our live lock.
  for(let index=0;index<16;index++){
    const port=40000+(parseInt(hash(index?`${key}:${index}`:key).slice(0,8),16)%20000);
    const lock=serverFactory(socket=>socket.destroy());
    try{
      await new Promise((ok,no)=>{lock.once('error',no);lock.listen(port,'127.0.0.1',ok);});
      return ()=>new Promise(ok=>lock.close(ok));
    }catch(e){
      try{lock.close(()=>{});}catch{}
      if(e.code==='EACCES'&&index<15)continue;
      const error=new InputError(e.code==='EADDRINUSE'?'Уже выполняется пакетный прогон в этом рабочем каталоге.':`Не удалось заблокировать очередь (${e.code==='EACCES'?'EACCES':'LISTEN_ERROR'}).`,409);
      error.code=e.code==='EADDRINUSE'?'WORKSPACE_BUSY':e.code==='EACCES'?'LOCK_PORT_DENIED':'LOCK_LISTEN_ERROR';throw error;
    }
  }
}

export class BatchManager{
  constructor(store,service){this.store=store;this.service=service;this.runs=new Store(join(store.directory,'runs'));this.active=null;this.pauseRequested=false;}
  async init(){await this.runs.init();return this;}
  async create(input,checklist,{subset='dev',concurrency=2}={}){
    requireThat(['dev','prod'].includes(subset),'Набор должен быть dev или prod.');
    requireThat(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=4,'Параллельность: от 1 до 4.');
    const conversations=importConversations(input);validateChecklist(checklist);
    requireThat(new Set(conversations.map(c=>c.conversation_id)).size===conversations.length,'В наборе повторяется conversation_id.');
    requireThat(conversations.every(c=>c.transcript.some(m=>m.speaker==='operator')),'Есть диалог без сообщений оператора.');
    const run_id=randomUUID(),execution=this.service.configuration(checklist),now=new Date().toISOString();
    const run={run_id,created_at:now,updated_at:now,status:'pending',subset,concurrency,checklist:structuredClone(checklist),
      execution,configuration_hash:hash(execution),dataset_hash:hash(conversations),
      tasks:conversations.map(conversation=>({conversation,conversation_id:conversation.conversation_id,status:'pending',evaluation_id:null,attempts:[]}))};
    await this.runs.write(run_id,run);return summarizeRun(run);
  }
  async get(id){return summarizeRun(await this.runs.read(id));}
  async list(){return (await this.runs.list()).map(summarizeRun);}
  async pause(id){requireThat(this.active?.id===id,'Этот прогон сейчас не выполняется.');this.pauseRequested=true;return {run_id:id,status:'pausing'};}
  async start(id,{retryFailed=false}={}){
    requireThat(!this.active,'Уже выполняется пакетный прогон.');
    const release=await acquireWorkspace(this.store.directory);
    // Recheck after the asynchronous mutex acquisition.
    if(this.active){await release();throw new InputError('Уже выполняется пакетный прогон.',409);}
    try{
      const run=await this.runs.read(id);
      requireThat(run.configuration_hash===hash(this.service.configuration(run.checklist)),'Настройки модели, промпта, схемы или справки изменились. Создайте новый прогон; смешивание версий запрещено.');
      this.pauseRequested=false;this.active={id,promise:null};
      const promise=this.work(run,{retryFailed}).finally(async()=>{this.active=null;await release();});
      this.active.promise=promise;
      // Background HTTP starts must still retain an observable failed manifest.
      promise.catch(()=>{});
      return {run_id:id,promise};
    }catch(e){this.active=null;await release();throw e;}
  }
  async work(run,{retryFailed}){
    const persist=()=>this.runs.transaction(()=>{run.updated_at=new Date().toISOString();return this.runs.write(run.run_id,structuredClone(run));});
    try{
      for(const task of run.tasks){
        if(task.status==='running'){
          let record;
          if(task.evaluation_id){try{record=await this.store.read(task.evaluation_id);}catch(e){if(e.status!==404)throw e;}}
          if(record&&terminal.has(record.status)){task.status=record.status;task.error=record.error??null;}
          else if(record){record.status='failed';record.ai_status='failed';record.final_status='failed';record.error='Прогон прерван во время оценки. Попытка сохранена; повтор запускается отдельно.';record.failed_at=new Date().toISOString();await this.store.write(record.evaluation_id,record);task.status='failed';task.error=record.error;}
          else if(!task.evaluation_id){task.status='pending';}
          else {task.status='failed';task.error='Не найдена запись прерванной попытки; требуется отдельный повтор.';}
          if(task.attempts.length&&task.status!=='pending')Object.assign(task.attempts.at(-1),{status:task.status,error:task.error??null});
        }
        if(retryFailed&&task.status==='failed'){task.status='pending';task.evaluation_id=null;task.error=null;}
      }
      if(run.error)(run.interruptions??=[]).push({at:run.updated_at,error:run.error,code:run.error_code??null});
      run.error=null;run.error_code=null;run.status='running';await persist();let next=0;
      const worker=async()=>{try{while(!this.pauseRequested){
        let task;while(next<run.tasks.length){const t=run.tasks[next++];if(t.status==='pending'){task=t;break;}}if(!task)return;
        task.status='running';task.error=null;await persist();
        try{
          const record=await this.service.evaluate(task.conversation,run.checklist,{runId:run.run_id,onCreated:async id=>{
            task.evaluation_id=id;task.attempts.push({evaluation_id:id,status:'running',started_at:new Date().toISOString()});await persist();
          }});
          task.status=record.status;task.error=record.error??null;
          Object.assign(task.attempts.at(-1),{status:record.status,finished_at:new Date().toISOString(),error:record.error??null});
        }catch(e){task.status='failed';task.error=e instanceof InputError?e.message:'Не удалось сохранить или выполнить попытку.';if(task.attempts.length)Object.assign(task.attempts.at(-1),{status:'failed',error:task.error});}
        await persist();
      }}catch(e){this.pauseRequested=true;throw e;}};
      const results=await Promise.allSettled(Array.from({length:run.concurrency},worker));
      for(const r of results)if(r.status==='rejected')throw r.reason;
      run.status=run.tasks.some(t=>t.status==='pending')?'paused':'completed';await persist();return summarizeRun(run);
    }catch(e){run.status='interrupted';run.error=e instanceof InputError?e.message:'Очередь прервана; сохранённые попытки доступны для продолжения.';run.error_code=e.code??null;await persist();throw e;}
  }
}
