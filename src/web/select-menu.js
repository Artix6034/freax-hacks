// Keep the native select as the source of truth for the existing controller.
// The visible list is portalled so transcript and result panels cannot clip it.
export function mountSelectMenus(root=document) {
 const mounted=new Map();let active=null,sequence=0;
 const close=()=>{active?.close();active=null;};
 function enhance(select){
  if(mounted.has(select)||select.multiple||select.size>1)return;
  const wrapper=document.createElement('span');wrapper.className='select-control';
  const trigger=document.createElement('button');trigger.type='button';trigger.className='select-trigger';
  const value=document.createElement('span');value.className='select-value';
  const arrow=document.createElement('span');arrow.className='select-arrow';arrow.setAttribute('aria-hidden','true');
  trigger.append(value,arrow);
  const menu=document.createElement('div');menu.className='select-menu';menu.hidden=true;menu.id=`cqa-list-${++sequence}`;
  menu.setAttribute('role','listbox');menu.setAttribute('popover','manual');
  trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',menu.id);
  select.before(wrapper);wrapper.append(select,trigger);document.body.append(menu);
  select.classList.add('select-native');select.setAttribute('tabindex','-1');select.setAttribute('aria-hidden','true');
  let open=false,highlight=-1,items=[],buffer='',lastKey=0;
  const available=()=>items.map((item,index)=>item.disabled?-1:index).filter(index=>index>=0);
  function position(){
   if(!open)return;
   const rect=trigger.getBoundingClientRect(),gap=7,below=window.innerHeight-rect.bottom-gap-12,above=rect.top-gap-12;
   const room=Math.max(80,Math.min(292,below>=Math.min(220,above)?below:above));
   menu.style.width=`${Math.min(Math.max(rect.width,180),window.innerWidth-24)}px`;
   menu.style.maxHeight=`${room}px`;
   menu.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-parseFloat(menu.style.width)-12))}px`;
   menu.style.top=`${below>=Math.min(220,above)?rect.bottom+gap:Math.max(12,rect.top-gap-Math.min(menu.scrollHeight,room))}px`;
  }
  function mark(index){
   highlight=index;
   for(const [i,item] of items.entries())item.element.classList.toggle('is-active',i===index);
   if(items[index]){trigger.setAttribute('aria-activedescendant',items[index].element.id);items[index].element.scrollIntoView({block:'nearest'});}
   else trigger.removeAttribute('aria-activedescendant');
  }
  function choose(index){
   if(items[index]?.disabled)return;
   select.selectedIndex=index;
   select.dispatchEvent(new Event('change',{bubbles:true}));
   sync();close();trigger.focus({preventScroll:true});
  }
  function sync(){
   const selected=select.options[select.selectedIndex];value.textContent=selected?.textContent||'Выберите значение';
   trigger.disabled=select.disabled;trigger.setAttribute('aria-busy',select.getAttribute('aria-busy')||'false');
   const label=select.closest('label');
   const name=select.getAttribute('aria-label')||Array.from(label?.childNodes??[]).filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).filter(Boolean).join(' ')||'Выбор значения';
   trigger.setAttribute('aria-label',name);menu.setAttribute('aria-label',name);
   menu.replaceChildren();items=Array.from(select.options).map((option,index)=>{
    const element=document.createElement('div');element.className='select-option';element.id=`${menu.id}-${index}`;element.textContent=option.textContent;
    const disabled=option.disabled||option.hidden||option.parentElement?.disabled===true;
    element.hidden=option.hidden;
    element.setAttribute('role','option');element.setAttribute('aria-selected',String(index===select.selectedIndex));element.setAttribute('aria-disabled',String(disabled));
    element.addEventListener('pointerdown',e=>e.preventDefault());
    element.addEventListener('pointermove',()=>{if(!disabled)mark(index);});
    element.addEventListener('click',()=>{if(!disabled)choose(index);});
    menu.append(element);return {element,disabled,text:option.textContent.toLocaleLowerCase()};
   });
   if(trigger.disabled&&open)close();else if(open){mark(available().includes(highlight)?highlight:select.selectedIndex);position();}
  }
  const form=select.form,reset=()=>setTimeout(sync,0),focus=()=>trigger.focus({preventScroll:true});
  const controller={close(){
   open=false;wrapper.classList.remove('is-open');trigger.setAttribute('aria-expanded','false');trigger.removeAttribute('aria-activedescendant');
   if(menu.hidePopover&&menu.matches(':popover-open'))menu.hidePopover();menu.hidden=true;
  },position,trigger,menu,dispose(){if(active===controller)close();observer.disconnect();select.removeEventListener('change',sync);select.removeEventListener('focus',focus);form?.removeEventListener('reset',reset);menu.remove();mounted.delete(select);}};
  function show(){
   if(trigger.disabled)return;
   close();active=controller;open=true;menu.hidden=false;
   if(menu.showPopover)try{menu.showPopover();}catch{}
   wrapper.classList.add('is-open');trigger.setAttribute('aria-expanded','true');position();mark(available().includes(select.selectedIndex)?select.selectedIndex:available()[0]??-1);
  }
  trigger.addEventListener('click',()=>open?close():show());
  trigger.addEventListener('keydown',event=>{
   const keys=available();
   if(event.key==='Tab'){close();return;}
   if(event.key==='Escape'&&open){event.preventDefault();close();return;}
   if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
    event.preventDefault();if(!open){show();return;}
    const at=keys.indexOf(highlight),index=event.key==='Home'?keys[0]:event.key==='End'?keys.at(-1):keys[(at+(event.key==='ArrowDown'?1:-1)+keys.length)%keys.length];mark(index??-1);return;
   }
   if(event.key==='Enter'||event.key===' '){event.preventDefault();if(open&&highlight>=0)choose(highlight);else show();return;}
   if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
    const now=Date.now();buffer=(now-lastKey>700?'':buffer)+event.key.toLocaleLowerCase();lastKey=now;
    const match=keys.find(i=>items[i].text.startsWith(buffer));if(match!==undefined){event.preventDefault();if(!open)show();mark(match);}
   }
  });
  select.addEventListener('change',sync);
  select.addEventListener('focus',focus);
  form?.addEventListener('reset',reset);
  const observer=new MutationObserver(sync);observer.observe(select,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','selected','label','aria-busy','aria-label']});
  mounted.set(select,controller);sync();
 }
 root.querySelectorAll('select').forEach(enhance);
 new MutationObserver(records=>{
  for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1){if(node.matches('select'))enhance(node);node.querySelectorAll('select').forEach(enhance);}
  for(const [select,controller] of mounted)if(!select.isConnected)controller.dispose();
 }).observe(root.body??root,{childList:true,subtree:true});
 document.addEventListener('pointerdown',event=>{if(active&&!active.trigger.contains(event.target)&&!active.menu.contains(event.target))close();});
 window.addEventListener('resize',()=>active?.position(),{passive:true});
 window.addEventListener('scroll',()=>active?.position(),{passive:true,capture:true});
 window.addEventListener('hashchange',close);
}
