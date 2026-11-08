import {mountSelectMenus} from './select-menu.js';
import {mountHeroDots} from './hero-dots.js';

export function mountPolish(){
 mountSelectMenus();if(!document.querySelector('#hero-widget'))mountHeroDots(document.querySelector('#hero-dot-stage'));
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'),animations=new Set();
 const disabled=()=>reduced.matches||document.documentElement.dataset.motion==='off';
 const groups=[['.landing-header',0],['.hero-copy > *',65],['.hero-visual',0],['.landing-section-heading',0],['.how-grid > article',70],['.feature-list > article',70],['.landing-cta',0],['.service-header',0],['.intro',0],['.metric',55],['.setup-card',65]];
 if(!('IntersectionObserver' in window))return;
 const observer=new IntersectionObserver(entries=>{
  for(const entry of entries)if(entry.isIntersecting){
   observer.unobserve(entry.target);if(disabled()||!entry.target.animate)continue;
   const animation=entry.target.animate([{opacity:0,transform:`translateY(${entry.target.matches('header')?'-12':'18'}px)`},{opacity:1,transform:'translateY(0)'}],{duration:650,delay:Number(entry.target.dataset.revealDelay||0),easing:'cubic-bezier(.22,1,.36,1)',fill:'backwards'});
   animations.add(animation);animation.finished.catch(()=>{}).finally(()=>animations.delete(animation));
  }
 },{threshold:.08});
 for(const [selector,stagger] of groups)document.querySelectorAll(selector).forEach((element,index)=>{element.dataset.revealDelay=String(Math.min(index*stagger,260));observer.observe(element);});
 const stop=()=>{if(disabled())for(const animation of animations)animation.cancel();};
 reduced.addEventListener('change',stop);window.addEventListener('cqa:motion',stop);
 // A timeline keeps one record expanded, just like the supplied component.
 document.querySelector('#history-list')?.addEventListener('toggle',event=>{
  if(event.target.matches('.history-entry')&&event.target.open)for(const item of document.querySelectorAll('.history-entry[open]'))if(item!==event.target)item.open=false;
 },true);
}
