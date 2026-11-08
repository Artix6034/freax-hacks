// Dynamics iframe contract. No transcript or model invocation until an allowed parent sends it.
export const BRIDGE='freax-cqa/v1';
export function acceptsParent(event,parent,origins){return event.source===parent&&origins.includes(event.origin)&&event.data?.channel===BRIDGE;}
export function evaluationSummary(record){return {evaluation_id:record.evaluation_id,conversation_id:record.conversation.conversation_id,status:record.status,checklist_version:record.checklist.version,total:record.final_score?.total??null,gross_error:record.final_score?.gross_error??null};}
export function connectEmbed({origins,loadConversation,onError,window:win=window}){
  if(win.parent===win)return ()=>{};
  let parentOrigin=null;
  const send=(type,payload)=>{if(parentOrigin)win.parent.postMessage({channel:BRIDGE,type,...payload},parentOrigin);};
  win.addEventListener('message',async event=>{
    if(!acceptsParent(event,win.parent,origins))return;
    if(event.data.type==='hello'){parentOrigin=event.origin;send('ready',{});return;}
    if(event.data.type!=='load-conversation'||event.origin!==parentOrigin)return;
    try{await loadConversation(event.data.conversation);send('loaded',{});}catch(e){onError(e.message);send('error',{message:e.message});}
  });
  return record=>send('evaluation',{result:evaluationSummary(record)});
}
