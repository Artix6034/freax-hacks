// Offline submission tools: no network, no model calls, no .env access.
import { readFile, writeFile, mkdir, rename, unlink, readdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildSubmission, validateSubmission, SubmissionError } from '../src/submission.js';
import { InputError } from '../src/domain.js';

const help=`CQA / Freax — экспорт JSON 1.0 без AI-вызовов

export     --subset dev|prod --dataset <исходный-API.json>
           (--evaluations <полные-Evaluation.json|jsonl> | --evaluations-dir <каталог>)
           [--latest --checklist-version 2] [--checklist-id freedom-chat]
           [--run-id <ID-единого-прогона>]
           [--view original|reviewed-final] [--team Freax] [--output results/<subset>/results.json]
readiness  те же параметры; только проверка, без записи файлов
validate   --subset dev|prod --dataset <исходный-API.json> --input <results.json>
           [--checklist <снимок-чеклиста.json>]

Без --latest дубли ID запрещены. С --latest явно нужна версия; берётся последняя
попытка этой версии, даже partial/failed. Основное представление — original AI.
С --run-id берётся последняя попытка каждого диалога внутри одного прогона.
Смешивание настроек модели, промпта, схемы и справки блокируется.
Вывод создаётся только при наличии оценки каждого исходного ID: DEV65, PROD10.
Ошибки/неопределённость сохраняются как error, а не как ноль или N/A.
Изменённые веса при validate требуют --checklist. Публикация в Git не выполняется.
`;

function parse(args) {
  const command=args.shift();
  if(!command||command==='help'||command==='--help')return {command:'help'};
  if(!['export','readiness','validate'].includes(command))throw new SubmissionError('ARGUMENTS','Команда должна быть export, readiness или validate.');
  const opts={command};
  const values=new Set(['subset','dataset','evaluations','evaluations-dir','checklist-id','checklist-version','view','team','output','input','checklist','run-id']);
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--help')return {command:'help'};
    if(arg==='--latest'){if(opts.latest)throw new SubmissionError('ARGUMENTS','Повторный --latest.');opts.latest=true;continue;}
    const name=arg.slice(2);
    if(!arg.startsWith('--')||!values.has(name)||!args[i+1]||args[i+1].startsWith('--')||Object.hasOwn(opts,name))throw new SubmissionError('ARGUMENTS','Неизвестный, повторный или незаполненный параметр. Используйте --help.');
    opts[name]=args[++i];
  }
  if(!['dev','prod'].includes(opts.subset)||!opts.dataset)throw new SubmissionError('ARGUMENTS','Нужны --subset dev|prod и --dataset с исходным набором.');
  if(opts['checklist-version']!==undefined){
    if(!/^[1-9]\d*$/.test(opts['checklist-version']))throw new SubmissionError('ARGUMENTS','Версия должна быть положительным целым числом.');
    opts['checklist-version']=Number(opts['checklist-version']);
    if(!Number.isSafeInteger(opts['checklist-version']))throw new SubmissionError('ARGUMENTS','Недопустимая версия.');
  }
  if(command==='validate'){
    if(!opts.input||opts.evaluations||opts['evaluations-dir']||opts.latest||opts.output||opts['run-id'])throw new SubmissionError('ARGUMENTS','Для validate нужен --input; выбор Evaluation и запись файла не выполняются.');
  }else{
    if(Boolean(opts.evaluations)===Boolean(opts['evaluations-dir'])||opts.input||opts.checklist)throw new SubmissionError('ARGUMENTS','Выберите ровно один источник: --evaluations или --evaluations-dir.');
  }
  return opts;
}

async function readJSON(path) {
  const buffer=await readFile(path);
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));}
  catch{throw new SubmissionError('INVALID_JSON','Файл должен содержать корректный JSON в UTF-8, без комментариев и лишних запятых.');}
}

async function evaluationsFrom(opts,cwd) {
  if(opts['evaluations-dir']){
    const directory=resolve(cwd,opts['evaluations-dir']);
    const files=(await readdir(directory)).filter(name=>/^[0-9a-f-]{36}\.json$/.test(name)).sort();
    return Promise.all(files.map(name=>readJSON(resolve(directory,name))));
  }
  const path=resolve(cwd,opts.evaluations);
  if(path.toLowerCase().endsWith('.jsonl')){
    const text=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(path));
    try{return text.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));}
    catch{throw new SubmissionError('INVALID_JSON','Некорректный JSONL с Evaluation.');}
  }
  const value=await readJSON(path);
  return Array.isArray(value)?value:[value];
}

async function atomicJSON(path,value,verify) {
  await mkdir(dirname(path),{recursive:true});
  const temp=path+'.'+randomUUID()+'.tmp';
  try {
    await writeFile(temp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx'});
    const written=await readJSON(temp);
    if(verify)verify(written);
    await rename(temp,path);
  }finally{
    try{await unlink(temp);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}

export async function main(args=process.argv.slice(2),{cwd=process.cwd(),out=console.log,err=console.error}={}) {
  try {
    const opts=parse([...args]);
    if(opts.command==='help'){out(help);return 0;}
    const dataset=await readJSON(resolve(cwd,opts.dataset));
    if(opts.command==='validate'){
      const document=await readJSON(resolve(cwd,opts.input));
      const checklist=opts.checklist?await readJSON(resolve(cwd,opts.checklist)):undefined;
      const report=validateSubmission(document,{dataset,subset:opts.subset,checklist});
      out(JSON.stringify({status:'valid',subset:opts.subset,...report}));return 0;
    }
    const config=await readJSON(new URL('../config/submission.json',import.meta.url));
    const evaluations=await evaluationsFrom(opts,cwd);
    const {document,report,checklist}=buildSubmission({dataset,subset:opts.subset,evaluations,teamName:opts.team??config.team_name,
      view:opts.view??'original',checklistId:opts['checklist-id']??(opts.latest?config.checklist_id:undefined),
      checklistVersion:opts['checklist-version'],latest:opts.latest??false,runId:opts['run-id']});
    if(opts.command==='readiness'){
      out(JSON.stringify({status:'ready_for_export',...report}));return 0;
    }
    const target=resolve(cwd,opts.output??`results/${opts.subset}/results.json`);
    if(basename(target)!=='results.json'||basename(dirname(target))!==opts.subset)throw new SubmissionError('OUTPUT_PATH','Путь должен оканчиваться на dev/results.json или prod/results.json соответственно набору.');
    const inputs=[opts.dataset,opts.evaluations].filter(Boolean).map(path=>resolve(cwd,path));
    if(inputs.includes(target))throw new SubmissionError('OUTPUT_PATH','Нельзя перезаписывать исходный набор или Evaluation файлом сдачи.');
    // Validate the serialized temporary file before atomically replacing a good old file.
    await atomicJSON(target,document,written=>validateSubmission(written,{dataset,subset:opts.subset,checklist}));
    const manifest=resolve(cwd,`data/submissions/${opts.subset}.manifest.json`);
    await atomicJSON(manifest,{generated_at:new Date().toISOString(),output:target,...report});
    out(JSON.stringify({status:'exported',output:target,manifest,...report}));return 0;
  } catch(error) {
    const known=error instanceof SubmissionError||error instanceof InputError;
    err(JSON.stringify({status:'blocked',code:error.code??'INPUT_ERROR',error:known?error.message:'Не удалось прочитать или записать файлы экспорта.',...(error instanceof SubmissionError?error.details:{})}));
    return 2;
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
