// A small HTML/Canvas adaptation of the supplied Dot Field component.
// Canvas is decorative; the real heading and all controls remain HTML.
export function mountHeroDots(stage){
 if(!stage)return;
 const canvas=stage.querySelector('canvas'),ctx=canvas.getContext('2d');if(!ctx)return;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let width=1,height=1,dpr=1,points=[],visible=false,raf=0,started=0,dirty=true;
 let pointer={x:-10000,y:-10000},last=0;
 const off=()=>reduced.matches||document.documentElement.dataset.motion==='off';
 function layout(){
  const rect=stage.getBoundingClientRect();width=Math.max(1,rect.width);height=Math.max(1,rect.height);dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
  const mask=document.createElement('canvas');mask.width=Math.round(width);mask.height=Math.round(height);
  const m=mask.getContext('2d',{willReadFrequently:true});if(!m)return;
  let size=width*.41;m.font=`750 ${size}px Manrope,Arial,sans-serif`;
  size*=width*.84/m.measureText('CQA').width;m.font=`750 ${size}px Manrope,Arial,sans-serif`;m.textAlign='center';m.textBaseline='middle';m.fillText('CQA',width/2,height*.48);
  const pixels=m.getImageData(0,0,mask.width,mask.height).data,gap=width<400?4:5;points=[];
  for(let y=2;y<mask.height;y+=gap)for(let x=2;x<mask.width;x+=gap)if(pixels[(y*mask.width+x)*4+3]>110){
   const sx=(Math.sin(x*12.98+y*78.23)*43758.5453)%1,sy=(Math.sin(y*9.17+x*41.7)*17932.318)%1;
   points.push({x:x+sx*width*.35,y:y+sy*height*.65,hx:x,hy:y,ox:sx*width*.35,oy:sy*height*.65,delay:(x/width)*220,vx:0,vy:0});
  }
  stage.classList.add('dots-ready');dirty=false;started=performance.now();last=started;
 }
 function frame(now){
  raf=0;if(!visible||document.hidden)return;if(dirty)layout();
  const disabled=off(),dt=Math.min(2,(now-last)/16.67||1);last=now;
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  let moving=false;
  for(const p of points){
   const age=disabled?1:Math.max(0,Math.min(1,(now-started-p.delay)/1150)),ease=1-Math.pow(1-age,4);
   const tx=p.hx+p.ox*(1-ease),ty=p.hy+p.oy*(1-ease);
   if(disabled){p.x=p.hx;p.y=p.hy;p.vx=p.vy=0;}
   else{
    const dx=p.x-pointer.x,dy=p.y-pointer.y,distance=Math.hypot(dx,dy);
    if(distance<72&&distance>.01){const force=(1-distance/72)*1.4*dt;p.vx+=dx/distance*force;p.vy+=dy/distance*force;}
    p.vx=(p.vx+(tx-p.x)*.055*dt)*Math.pow(.76,dt);p.vy=(p.vy+(ty-p.y)*.055*dt)*Math.pow(.76,dt);p.x+=p.vx*dt;p.y+=p.vy*dt;
    if(age<1||Math.abs(p.vx)+Math.abs(p.vy)>.035||Math.abs(p.x-p.hx)+Math.abs(p.y-p.hy)>.1)moving=true;
   }
   const displaced=Math.hypot(p.x-p.hx,p.y-p.hy)>3;
   ctx.fillStyle=displaced||p.hx>width*.71?'#4FAF3D':'#000';ctx.globalAlpha=disabled?1:Math.min(1,age*2+.06);
   ctx.beginPath();ctx.arc(p.x,p.y,width<400?1.25:1.55,0,Math.PI*2);ctx.fill();
  }
  ctx.globalAlpha=1;if(moving&&!disabled)raf=requestAnimationFrame(frame);
 }
 const wake=()=>{if(visible&&!raf&&!document.hidden)raf=requestAnimationFrame(frame);};
 stage.addEventListener('pointermove',event=>{if(event.pointerType==='touch'||off())return;const r=stage.getBoundingClientRect();pointer={x:event.clientX-r.left,y:event.clientY-r.top};wake();});
 stage.addEventListener('pointerleave',()=>{pointer={x:-10000,y:-10000};wake();});
 new IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting??false;if(visible)wake();else{cancelAnimationFrame(raf);raf=0;}},{rootMargin:'20px'}).observe(stage);
 new ResizeObserver(()=>{dirty=true;wake();}).observe(stage);
 document.addEventListener('visibilitychange',wake);window.addEventListener('cqa:motion',wake);reduced.addEventListener('change',wake);
 document.fonts?.ready.then(()=>{dirty=true;wake();});
}
