import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderEvidenceHTML,roleLabel} from '../src/web/evidence.js';
import {calculate} from '../src/scoring.js';
import {submissionCompatibility} from '../src/web/submission-compatibility.js';
import {connectEmbed} from '../src/web/embed.js';
import {importConversations} from '../src/domain.js';
import {TEACHING_CONVERSATION} from '../src/web/examples.js';

// A small DOM boundary for exercising the actual controller, without a browser
// or AI calls. Presentation/rendering is not simulated as a visual test.
class Element {
  value='0';textContent='';innerHTML='';disabled=false;hidden=false;dataset={};listeners={};attributes={};
  addEventListener(name,fn){this.listeners[name]=fn;}
  setAttribute(name,value){this.attributes[name]=value;}
  replaceChildren(){this.innerHTML='';}
  append(child){this.innerHTML+=child.textContent;}
  scrollIntoView(){}
}
const source=await readFile(new URL('../src/web/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../src/web/index.html',import.meta.url),'utf8');
const checklist=JSON.parse(await readFile(new URL('../config/checklist.v1.json',import.meta.url),'utf8'));
async function controller({search='',status={}}={}){
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>[`#${m[1]}`,new Element()]));
  const document={querySelector:s=>elements.get(s)??null,querySelectorAll:()=>[],createElement:()=>new Element()};
  const requests=[],imports=[],messages=[],handlers=new Map();let finish;
  const parent={postMessage:(data,origin)=>messages.push({data,origin})};
  const win={location:{search},addEventListener:(type,fn)=>{if(!handlers.has(type))handlers.set(type,[]);handlers.get(type).push(fn);},dispatchEvent(event){for(const fn of handlers.get(event.type)??[])fn(event);}};
  win.parent=search.includes('embed=1')?parent:win;
  const fetch=async(path,options)=>{
    if(path==='/api/status')return {ok:true,json:async()=>({ready:true,model:'TEST ONLY',missing:[],batch_supported:false,...status})};
    if(path==='/api/import'){imports.push(JSON.parse(options.body));return {ok:true,json:async()=>({conversations:importConversations(JSON.parse(options.body))})};}
    if(path==='/api/checklists')return {ok:true,json:async()=>[structuredClone(checklist)]};
    if(path==='/api/evaluations'){
      requests.push(JSON.parse(options.body));return new Promise(resolve=>{finish=result=>resolve({ok:true,json:async()=>result});});
    }
    throw Error(`Unexpected request: ${path}`);
  };
  const fn=new (Object.getPrototypeOf(async function(){}).constructor)('document','window','fetch','CustomEvent','renderEvidenceHTML','roleLabel','submissionCompatibility','connectEmbed','TEACHING_CONVERSATION',source.replace(/^import[^\n]+\n/gm,'')+'\nreturn {useConversations,renderResult,getChecklist:selectedChecklist,state:()=>({activeConversation,evaluation,running})};');
  const app=await fn(document,win,fetch,class{constructor(type,init){this.type=type;Object.assign(this,init);}},renderEvidenceHTML,roleLabel,submissionCompatibility,connectEmbed,TEACHING_CONVERSATION);
  return {app,elements,requests,imports,messages,parent,receive:async event=>{for(const fn of handlers.get('message')??[])await fn(event);},finish:r=>finish(r)};
}
const conversation=id=>({conversation_id:id,channel:'agent chat',language:'RU',audio_url:null,transcript:[{message_id:'m0001',speaker:'operator',timestamp:'00:01',text:`СИНТЕТИЧЕСКИЙ ТЕСТ ${id}`} ]});

test('the teaching example is imported and never starts a model request',async()=>{
  const c=await controller();await c.elements.get('#example-import').onclick();
  assert.equal(c.app.state().activeConversation.conversation_id,'TEACHING_EXAMPLE_RU');
  assert.equal(c.app.state().evaluation,null);assert.equal(c.requests.length,0);
  assert.deepEqual(c.imports,[TEACHING_CONVERSATION]);
  assert.match(c.elements.get('#notice').textContent,/вымышленный учебный диалог/);
  assert.equal(c.elements.get('#example-import').disabled,false);
});

test('the teaching example cannot replace an already imported collection',async()=>{
  const c=await controller();c.app.useConversations([conversation('KEEP_EXISTING')]);
  await c.elements.get('#example-import').onclick();
  assert.equal(c.app.state().activeConversation.conversation_id,'KEEP_EXISTING');
  assert.equal(c.imports.length,0);assert.equal(c.requests.length,0);
});

test('response for A preserves B after selection changes, next request uses B',async()=>{
  const c=await controller();c.app.useConversations([conversation('A'),conversation('B')]);
  const first=c.elements.get('#evaluate').onclick();
  assert.equal(c.elements.get('#result').attributes['aria-busy'],'true');
  assert.match(c.elements.get('#result').innerHTML,/loading-placeholder/);
  c.elements.get('#conversation-select').value='1';c.elements.get('#conversation-select').listeners.change();
  c.finish({status:'failed',error:'TEST',conversation:conversation('A')});await first;
  assert.equal(c.app.state().activeConversation.conversation_id,'B');
  assert.equal(c.elements.get('#conversation-select').value,'1');
  assert.equal(c.app.state().evaluation,null);
  assert.equal(c.elements.get('#result').attributes['aria-busy'],'false');
  assert.doesNotMatch(c.elements.get('#result').innerHTML,/loading-placeholder/);
  assert.match(c.elements.get('#notice').textContent,/A.*истории/);
  const second=c.elements.get('#evaluate').onclick();
  assert.equal(c.requests[1].conversation.conversation_id,'B');
  // Keep this synthetic response out of renderResult; switch before resolving.
  c.elements.get('#conversation-select').value='0';c.elements.get('#conversation-select').listeners.change();
  c.finish({status:'failed',error:'TEST',conversation:conversation('B')});await second;
});
test('opening a saved conversation synchronizes selector with displayed snapshot',async()=>{
  const c=await controller();c.app.useConversations([conversation('A')]);
  const saved=conversation('A');saved.transcript[0].text='СИНТЕТИЧЕСКИЙ ТЕСТ: другая сохранённая версия';
  c.app.renderResult({status:'failed',error:'TEST ONLY',conversation:saved,checklist});
  assert.equal(c.app.state().activeConversation.transcript[0].text,saved.transcript[0].text);
  assert.equal(c.elements.get('#conversation-select').value,'1');
});
test('HTML retains every literal controller target and has no duplicate IDs',()=>{
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length);
  for(const [,id] of source.matchAll(/\$\('#([\w-]+)'\)/g))assert.ok(ids.includes(id),`Missing #${id}`);
});

test('evaluation skeleton stops on a failed response and preserves the failure details',async()=>{
  const c=await controller();c.app.useConversations([conversation('A')]);
  const pending=c.elements.get('#evaluate').onclick();
  assert.equal(c.elements.get('#result').attributes['aria-busy'],'true');
  c.finish({status:'failed',error:'SYNTHETIC provider failure',conversation:conversation('A'),checklist});await pending;
  assert.equal(c.elements.get('#result').attributes['aria-busy'],'false');
  assert.doesNotMatch(c.elements.get('#result').innerHTML,/loading-placeholder/);
  assert.match(c.elements.get('#result').innerHTML,/SYNTHETIC provider failure/);
  assert.equal(c.app.state().running,false);
});

test('result presentation keeps original and final scores separate and retains source links',async()=>{
  const c=await controller(),input=conversation('RESULT_TEST');c.app.useConversations([input]);
  const original={criteria:checklist.criteria.map(x=>({criterion_id:x.id,status:'resolved',value:x.type==='flag'?'no':x.type==='scale'?x.scale.at(-1).value:'yes',explanation:'SYNTHETIC UI TEST',evidence:[{message_id:'m0001',quote:input.transcript[0].text}],checked_ranges:[],missing_information:[],na_reason:'',na_condition:''}))};
  const final=structuredClone(original);final.criteria[0].value='no';
  const record={evaluation_id:'TEST_ONLY',status:'completed',conversation:input,checklist,ai_review:original,final_review:final,original_score:calculate(checklist,original,input.channel),final_score:calculate(checklist,final,input.channel),appeals:[]};
  const before=JSON.stringify(record);c.app.renderResult(record);
  const rendered=c.elements.get('#result').innerHTML;
  assert.match(rendered,/Исходный AI<\/span><strong>100,00/);
  assert.match(rendered,/Финальная версия<\/span><strong>90,00/);
  assert.match(rendered,/data-from="m0001"/);
  assert.match(rendered,/Расчёт баллов/);
  assert.equal(JSON.stringify(record),before);
});

test('a partial result displays an unknown total rather than a numerical score',async()=>{
  const c=await controller(),input=conversation('PARTIAL_UI_TEST');c.app.useConversations([input]);
  const review={criteria:checklist.criteria.map(x=>({criterion_id:x.id,status:'resolved',value:x.type==='flag'?'no':x.type==='scale'?x.scale.at(-1).value:'yes',explanation:'SYNTHETIC UI TEST',evidence:[],checked_ranges:[],missing_information:[],na_reason:'',na_condition:''}))};
  Object.assign(review.criteria[0],{status:'unresolved',value:null,missing_information:['SYNTHETIC: missing information']});
  const score=calculate(checklist,review,input.channel);
  c.app.renderResult({evaluation_id:'TEST_ONLY',status:'partial',conversation:input,checklist,ai_review:review,final_review:review,original_score:score,final_score:score,appeals:[]});
  assert.match(c.elements.get('#result').innerHTML,/<div class="score-value">Не рассчитан<\/div>/);
  assert.match(c.elements.get('#result').innerHTML,/SYNTHETIC: missing information/);
  assert.equal(c.app.state().evaluation.final_score.total,null);
});

test('an incompatible checklist retains the explicit choice before a paid evaluation',async()=>{
  const c=await controller(),input=conversation('CUSTOM_TEST');
  c.app.getChecklist().criteria.push({...structuredClone(checklist.criteria[0]),id:'custom'});
  c.app.useConversations([input]);
  assert.equal(c.elements.get('#evaluate').disabled,true);
  await c.elements.get('#evaluate').onclick();assert.equal(c.requests.length,0);
  c.elements.get('#allow-incompatible').checked=true;c.elements.get('#allow-incompatible').onchange();
  assert.equal(c.elements.get('#evaluate').disabled,false);
  const pending=c.elements.get('#evaluate').onclick();assert.equal(c.requests.length,1);
  c.finish({status:'failed',error:'SYNTHETIC TEST',conversation:input,checklist:c.app.getChecklist()});await pending;
});

test('the redesigned embed imports only from its allowed parent and does not start AI',async()=>{
  const c=await controller({search:'?embed=1',status:{embed_origins:['https://crm.example']}});
  const message=(origin,type)=>({source:c.parent,origin,data:{channel:'freax-cqa/v1',type,conversation:conversation('EMBED_TEST')}});
  await c.receive(message('https://other.example','hello'));
  await c.receive(message('https://crm.example','load-conversation'));assert.equal(c.app.state().activeConversation,null);
  await c.receive(message('https://crm.example','hello'));
  await c.receive(message('https://crm.example','load-conversation'));
  assert.equal(c.app.state().activeConversation.conversation_id,'EMBED_TEST');
  assert.equal(c.requests.length,0);
  assert.deepEqual(c.messages.map(m=>m.data.type),['ready','loaded']);
  assert.ok(c.messages.every(m=>m.origin==='https://crm.example'));
});
