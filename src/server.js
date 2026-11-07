import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Store } from './store.js';
import { EvaluationService } from './service.js';
import { InputError, requireThat, importConversations, validateChecklist,hash } from './domain.js';
import { providerConfig, createProvider,PROMPT_VERSION } from './ai/provider.js';
import {SCHEMA_VERSION} from './ai/schema.js';
import {SYSTEM_PROMPT} from './ai/prompt.js';
import {BatchManager} from './batch.js';
import {buildSubmission,SubmissionError} from './submission.js';
import { datasetReady, importRemoteDataset } from './datasets.js';
import { filterHistory } from './history.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
async function body(req, objectOnly = true) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new InputError('Файл больше 8 МБ.', 413); chunks.push(chunk); }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('Некорректный JSON.'); }
  requireThat(!objectOnly || (parsed && typeof parsed === 'object' && !Array.isArray(parsed)), 'Ожидается JSON-объект.');
  return parsed;
}

export async function createApp({ directory = resolve(root, 'data'), provider, config = providerConfig(), referenceText,
  datasetUrl = process.env.CQA_DATASET_URL, devFile = resolve(root, 'data/dev/api-response.json') } = {}) {
  const store = new Store(directory); await store.init();
  // Single-process local store: interrupted work must not look indefinitely active.
  for (const r of await store.list()) {
    let alive=false;if(r.execution_pid)try{process.kill(r.execution_pid,0);alive=true;}catch{}
    if (r.status === 'running'&&!r.run_id&&!alive) {
      r.status = 'failed'; r.ai_status='failed';r.final_status='failed';r.error = 'Сервис был перезапущен во время оценки. Запустите новую оценку.';
      r.failed_at = new Date().toISOString(); await store.write(r.evaluation_id, r);
    }
  }
  try { await store.read('checklists'); } catch (e) {
    if (e.status !== 404) throw e;
    const initial = JSON.parse(await readFile(resolve(root, 'config/checklist.v1.json'), 'utf8'));
    await store.write('checklists', [validateChecklist(initial)]);
  }
  if (referenceText === undefined) referenceText = process.env.CQA_REFERENCE_FILE ? await readFile(resolve(process.env.CQA_REFERENCE_FILE), 'utf8') : '';
  const service = new EvaluationService(store, provider ?? createProvider(config), referenceText, process.env.CQA_REFERENCE_VERSION || '');
  const batches=await new BatchManager(store,service).init();
  let localDevReady = false;
  try { await readFile(devFile, 'utf8'); localDevReady = true; } catch { /* Optional private dataset. */ }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      // This prototype is intentionally local; prevent cross-site writes to the local AI proxy.
      if (req.method !== 'GET') {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new InputError('Запрос с другого сайта запрещён.', 403);
        requireThat(req.headers['content-type']?.startsWith('application/json'), 'Ожидается Content-Type: application/json.');
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { ready: config.ready, configured:config.ready, access_status:'not_verified', provider: config.provider, model: config.model, missing: config.missing, reference_loaded: Boolean(referenceText), dataset_ready:datasetReady(datasetUrl), local_dev_ready:localDevReady,
        prompt_version:PROMPT_VERSION,prompt_hash:hash(SYSTEM_PROMPT),schema_version:SCHEMA_VERSION,reference_hash:hash(referenceText),active_run_id:batches.active?.id??null,batch_supported:true });
      if(req.method==='GET'&&url.pathname==='/api/runs')return json(res,200,await batches.list());
      if(req.method==='POST'&&url.pathname==='/api/runs'){
        const input=await body(req),all=await store.read('checklists');
        const checklist=all.find(c=>c.checklist_id===input.checklist_id&&c.version===input.checklist_version);
        requireThat(checklist,'Выберите сохранённую версию чек-листа.');
        const run=await batches.create(input.conversations,checklist,{subset:input.subset,concurrency:input.concurrency??2});
        await batches.start(run.run_id);return json(res,202,await batches.get(run.run_id));
      }
      const runMatch=/^\/api\/runs\/([0-9a-f-]{36})(?:\/(resume|pause|submission))?$/.exec(url.pathname);
      if(runMatch){
        const [,id,action]=runMatch;
        if(req.method==='GET'&&!action)return json(res,200,await batches.get(id));
        if(req.method==='POST'&&action==='pause'){await body(req);return json(res,202,await batches.pause(id));}
        if(req.method==='POST'&&action==='resume'){
          const input=await body(req);requireThat(input.retry_failed===undefined||typeof input.retry_failed==='boolean','Некорректный режим повторов.');
          await batches.start(id,{retryFailed:input.retry_failed??false});return json(res,202,await batches.get(id));
        }
        if(req.method==='GET'&&action==='submission'){
          const run=await batches.runs.read(id);requireThat(run.tasks.every(t=>['completed','partial','failed'].includes(t.status)),'Дождитесь завершения всех диалогов.');
          const evaluations=await Promise.all(run.tasks.filter(t=>t.evaluation_id).map(t=>store.read(t.evaluation_id)));
          const result=buildSubmission({dataset:run.tasks.map(t=>t.conversation),subset:run.subset,evaluations,runId:id});
          return json(res,200,result.document);
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/import') return json(res, 200, { conversations: importConversations(await body(req, false)) });
      if (req.method === 'POST' && url.pathname === '/api/datasets/import') {
        const input=await body(req);
        return json(res, 200, { conversations: await importRemoteDataset(datasetUrl, input.group_id) });
      }
      if (req.method === 'POST' && url.pathname === '/api/datasets/local-dev') {
        await body(req);
        if (!localDevReady) throw new InputError('Сохранённый DEV недоступен. Загрузите JSON-файл.', 404);
        return json(res, 200, { conversations: importConversations(JSON.parse(await readFile(devFile, 'utf8'))) });
      }
      if (req.method === 'GET' && url.pathname === '/api/checklists') return json(res, 200, await store.read('checklists'));
      if (req.method==='POST' && url.pathname==='/api/checklists/organizer-update') {
        await body(req);
        const template=JSON.parse(await readFile(resolve(root,'config/checklist.organizer-2026-11-07.json'),'utf8'));
        const saved=await store.transaction(async()=>{
          const all=await store.read('checklists');
          const existing=all.find(c=>c.provenance?.release_id===template.provenance.release_id);
          if(existing)return existing;
          const version=Math.max(0,...all.filter(c=>c.checklist_id===template.checklist_id).map(c=>c.version))+1;
          const next=validateChecklist({...template,version});all.push(next);await store.write('checklists',all);return next;
        });
        return json(res,200,saved);
      }
      if (req.method === 'POST' && url.pathname === '/api/checklists') {
        const input = await body(req);
        const saved = await store.transaction(async () => {
          const all = await store.read('checklists');
          const latest = all.filter(c => c.checklist_id === input.checklist_id).at(-1);
          requireThat(latest && latest.version === input.version, 'Версия чек-листа изменилась. Загрузите её заново.');
          const next = validateChecklist({ ...input, schema_version: '1.0', version: latest.version + 1 });
          all.push(next); await store.write('checklists', all); return next;
        });
        return json(res, 201, saved);
      }
      if (req.method === 'POST' && url.pathname === '/api/evaluations') {
        const input = await body(req);
        const all = await store.read('checklists');
        const checklist = all.find(c => c.checklist_id === input.checklist_id && c.version === input.checklist_version);
        requireThat(checklist, 'Сначала сохраните и выберите версию чек-листа.');
        return json(res, 201, await service.evaluate(input.conversation, checklist));
      }
      if (req.method === 'GET' && url.pathname === '/api/evaluations') {
        const records = await store.list();
        return json(res,200,filterHistory(records,url.searchParams));
      }
      const match = /^\/api\/evaluations\/([0-9a-f-]{36})(?:\/(appeals|resolve))?$/.exec(url.pathname);
      if (match) {
        if (req.method === 'GET' && !match[2]) return json(res, 200, await store.read(match[1]));
        if (req.method === 'POST' && match[2]) return json(res, 200, await service[match[2] === 'appeals' ? 'appeal' : 'resolve'](match[1], await body(req)));
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/evidence.js':['evidence.js','text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && assets[url.pathname]) {
        const [name, type] = assets[url.pathname];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(await readFile(resolve(root, 'src/web', name)));
      }
      json(res, 404, { error: 'Не найдено.' });
    } catch (e) { json(res, e instanceof InputError ? e.status : e instanceof SubmissionError?400:500, { error: e instanceof InputError||e instanceof SubmissionError ? e.message : 'Внутренняя ошибка сервиса.' }); }
  });
  return { server, store, service,batches };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = await createApp();
  server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`CQA: http://127.0.0.1:${server.address().port}`));
}
