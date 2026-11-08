import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/web/workspace.js',import.meta.url),'utf8')).replace(/^import[^\n]+\nmountComponents\(\);\n/,'');
const html=await readFile(new URL('../src/web/index.html',import.meta.url),'utf8');
function navigation(hash='',search=''){
 const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>[m[1],{hidden:false,value:'',dataset:{},textContent:'',addEventListener(){},setAttribute(){},scrollIntoView(){this.scrolled=true;},focus(){}}]));
 const handlers=new Map(),location={hash,search};
 const document={documentElement:{dataset:{}},querySelector:s=>elements.get(s.slice(1)),getElementById:id=>elements.get(id),querySelectorAll:()=>[]};
 const window={addEventListener:(name,fn)=>{if(!handlers.has(name))handlers.set(name,[]);handlers.get(name).push(fn);},dispatchEvent(){},matchMedia:()=>({matches:false,addEventListener(){}}),scrollTo(){}};
 new Function('document','window','location','localStorage','CustomEvent','requestAnimationFrame',source)(document,window,location,{getItem(){return null;},setItem(){}},class{constructor(type,data){this.type=type;Object.assign(this,data);}},fn=>{fn();return 0;});
 return {elements,document,go(hash){location.hash=hash;for(const fn of handlers.get('hashchange')??[])fn();}};
}
test('landing opens first; entering and leaving the service preserves the imported UI state',()=>{
 const n=navigation();assert.equal(n.elements.get('landing-view').hidden,false);assert.equal(n.elements.get('service-view').hidden,true);
 const selected=n.elements.get('conversation-select');selected.value='TEST imported conversation';
 n.go('#service');assert.equal(n.elements.get('landing-view').hidden,true);assert.equal(n.elements.get('service-view').hidden,false);
 n.go('#home');n.go('#service');assert.equal(n.elements.get('conversation-select'),selected);assert.equal(selected.value,'TEST imported conversation');
});
test('deep links open the service and the requested editor; embed skips the landing',()=>{
 const n=navigation('#editor');assert.equal(n.elements.get('service-view').hidden,false);assert.equal(n.elements.get('editor').hidden,false);assert.equal(n.elements.get('editor').scrolled,true);
 const embed=navigation('','?embed=1');assert.equal(embed.elements.get('landing-view').hidden,true);assert.equal(embed.document.documentElement.dataset.embed,'true');
});

test('batch navigation expands its controls and preserves the selected conversation',()=>{
 const n=navigation('#service'),selected=n.elements.get('conversation-select');selected.value='TEST selected dialogue';
 n.go('#batch-panel');assert.equal(n.elements.get('batch-disclosure').open,true);assert.equal(n.elements.get('batch-panel').scrolled,true);
 n.go('#service');assert.equal(selected.value,'TEST selected dialogue');
});
