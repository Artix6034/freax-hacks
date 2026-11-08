/* HTML web resource owns the iframe. Exact origin and window checks in both directions. */
window.FreaxHost=(()=>{
  const channel='freax-cqa/v1',frame=document.getElementById('freax'),status=document.getElementById('status');
  let target=null,conversation=null,onResult=()=>{},handshake=null,timeout=null;
  function send(type,extra={}){frame.contentWindow.postMessage({channel,type,...extra},target);}
  window.addEventListener('message',event=>{
    if(event.source!==frame.contentWindow||event.origin!==target||event.data?.channel!==channel)return;
    if(event.data.type==='ready'){clearInterval(handshake);send('load-conversation',{conversation});}
    if(event.data.type==='loaded'){clearTimeout(timeout);status.hidden=true;}
    if(event.data.type==='error'){clearTimeout(timeout);status.hidden=false;status.textContent=event.data.message;}
    if(event.data.type==='evaluation')onResult(event.data.result);
  });
  function init(config){
    const url=new URL(config.appUrl);
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('Freax requires HTTPS.');
    target=url.origin;conversation=config.conversation;onResult=typeof config.onResult==='function'?config.onResult:()=>{};
    url.searchParams.set('embed','1');frame.hidden=false;status.hidden=false;status.textContent='Подключение Freax…';
    clearInterval(handshake);clearTimeout(timeout);
    frame.onload=()=>{send('hello');handshake=setInterval(()=>send('hello'),1000);};frame.src=url.href;
    timeout=setTimeout(()=>{clearInterval(handshake);status.hidden=false;status.textContent='Нет связи с Freax. Проверьте адрес, вход в Brev и разрешённый CRM origin.';},20000);
  }
  return {init};
})();
