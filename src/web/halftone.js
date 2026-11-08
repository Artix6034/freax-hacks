// Halftone Wordmark Footer: canvas adaptation of the React reference supplied
// by the user. The area coverage, spring and warmth helpers keep its behavior.
export function hwfRadius(coverage,gap){return Math.sqrt(Math.max(0,Math.min(1,coverage)))*gap*.56;}
export function hwfStep(x,y,vx,vy,hx,hy,px,py,r){
 const dx=x-px,dy=y-py,d2=dx*dx+dy*dy;
 if(r>0&&d2<r*r){const d=Math.sqrt(d2)+.001,f=(1-d/r)*2.6;vx+=dx/d*f;vy+=dy/d*f;}
 vx=(vx+(hx-x)*.05)*.84;vy=(vy+(hy-y)*.05)*.84;
 return [x+vx,y+vy,vx,vy];
}
export function hwfWarmth(x,y,hx,hy,span){return span>0?Math.min(1,Math.hypot(x-hx,y-hy)/span):0;}
export function mountHalftone(root,canvas){
 let ctx;try{ctx=canvas?.getContext('2d');}catch{}if(!root||!ctx)return;
 const container=canvas.parentElement,reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let width=1,height=1,dpr=1,dots=[],raf=0,visible=false,dirty=true,resizeTimer;
 let px=-1e5,py=-1e5,ring={x:0,y:0,t:-1e9};
 const off=()=>reduced.matches||document.documentElement.dataset.motion==='off';
 function layout(){
  const rect=container.getBoundingClientRect();width=Math.max(1,Math.round(rect.width));height=Math.max(1,Math.round(rect.height));dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
  const mask=document.createElement('canvas');mask.width=width;mask.height=height;
  const m=mask.getContext('2d',{willReadFrequently:true});if(!m)return;
  const face='Manrope, Arial, sans-serif';m.font=`900 100px ${face}`;
  const size=width*1.02/m.measureText('freax').width*100;m.font=`900 ${size}px ${face}`;
  const box=m.measureText('freax'),cap=box.actualBoundingBoxAscent||size*.72;
  m.fillStyle='#000';m.fillText('freax',(width-box.width)/2,height+cap*.14);
  const pixels=m.getImageData(0,0,width,height).data,gap=width<500?4.5:6;dots=[];
  for(let gy=0;gy<Math.ceil(height/gap);gy++)for(let gx=0;gx<Math.ceil(width/gap);gx++){
   let sum=0;for(let sy=0;sy<3;sy++)for(let sx=0;sx<3;sx++){
    const x=Math.min(width-1,Math.floor(gx*gap+(sx+.5)*gap/3)),y=Math.min(height-1,Math.floor(gy*gap+(sy+.5)*gap/3));sum+=pixels[(y*width+x)*4+3];
   }
   const coverage=sum/(9*255);if(coverage<.06)continue;
   const x=gx*gap+gap/2,y=gy*gap+gap/2;dots.push({x,y,hx:x,hy:y,vx:0,vy:0,r:hwfRadius(coverage,gap)});
  }
  container.classList.add('canvas-ready');dirty=false;
 }
 function draw(now){
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  let moving=false;const disabled=off(),age=now-ring.t,ringRadius=age*.9;
  for(const dot of dots){
   if(disabled){dot.x=dot.hx;dot.y=dot.hy;dot.vx=dot.vy=0;}
   else{
    if(age<900){const dx=dot.hx-ring.x,dy=dot.hy-ring.y,d=Math.hypot(dx,dy)+.001,band=1-Math.min(1,Math.abs(d-ringRadius)/26),f=band*3.2*(1-age/900);dot.vx+=dx/d*f;dot.vy+=dy/d*f;}
    [dot.x,dot.y,dot.vx,dot.vy]=hwfStep(dot.x,dot.y,dot.vx,dot.vy,dot.hx,dot.hy,px,py,76);
    if(Math.abs(dot.vx)+Math.abs(dot.vy)>.02||Math.abs(dot.x-dot.hx)+Math.abs(dot.y-dot.hy)>.05)moving=true;
    else{dot.x=dot.hx;dot.y=dot.hy;dot.vx=dot.vy=0;}
   }
   const k=hwfWarmth(dot.x,dot.y,dot.hx,dot.hy,28);ctx.fillStyle=k>.02?'#4FAF3D':'#fff';
   ctx.beginPath();ctx.arc(dot.x,dot.y,dot.r,0,Math.PI*2);ctx.fill();
  }
  return !disabled&&(moving||age<900||px>-1e4);
 }
 function frame(now){raf=0;if(!visible||document.hidden)return;if(dirty)layout();if(draw(now))raf=requestAnimationFrame(frame);}
 function wake(){if(!raf&&visible&&!document.hidden)raf=requestAnimationFrame(frame);}
 function local(e){const box=container.getBoundingClientRect();return [e.clientX-box.left,e.clientY-box.top];}
 root.addEventListener('pointermove',e=>{if(off()||e.pointerType==='touch')return;[px,py]=local(e);wake();});
 root.addEventListener('pointerleave',()=>{px=py=-1e5;wake();});
 root.addEventListener('pointerdown',e=>{if(off()||e.target.closest('a,button'))return;const [x,y]=local(e);ring={x,y,t:performance.now()};wake();});
 new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{dirty=true;wake();},80);}).observe(container);
 new IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting??true;if(visible)wake();else{cancelAnimationFrame(raf);raf=0;}},{rootMargin:'60px'}).observe(root);
 document.addEventListener('visibilitychange',wake);window.addEventListener('cqa:motion',wake);reduced.addEventListener('change',wake);
 document.fonts?.ready.then(()=>{dirty=true;wake();});
}
