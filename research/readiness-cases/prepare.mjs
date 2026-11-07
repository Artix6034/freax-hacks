import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeConversation, validateChecklist, hash } from '../../src/domain.js';
import { buildMessages, PROMPT_VERSION } from '../../src/ai/provider.js';
import { buildReviewSchema, SCHEMA_VERSION } from '../../src/ai/schema.js';

const suite=JSON.parse(await readFile(new URL('./cases.json',import.meta.url),'utf8'));
const original=JSON.parse(await readFile(new URL('../../config/checklist.v1.json',import.meta.url),'utf8'));
const output=new URL('./prepared/',import.meta.url);await mkdir(output,{recursive:true});
const requests=[],seen=new Set();let assertions=0;
const check=(condition,detail)=>{if(!condition)throw Error(detail);assertions++;};
for(const [index,c] of suite.cases.entries()){
 check(!seen.has(c.id),'Duplicate case ID');seen.add(c.id);
 const checklist=structuredClone(original);
 if(c.additional_criterion){checklist.criteria.push(c.additional_criterion);checklist.version++;}
 validateChecklist(checklist);
 const conversation=normalizeConversation({conversation_id:'readiness-'+String(index+1).padStart(3,'0'),channel:'agent chat',language:c.language,audio_url:null,
  transcript:c.messages.map(([speaker,text],i)=>({speaker,text,timestamp:String(Math.floor(i/60)).padStart(2,'0')+':'+String(i%60).padStart(2,'0')}))});
 const schema=buildReviewSchema(checklist,conversation.channel,conversation),messages=buildMessages(conversation,checklist,c.reference_text||'','json_schema');
 const payload=JSON.parse(messages[1].content);
 check(payload.conversation.transcript.length===c.messages.length,'Lost messages');
 check(!Object.hasOwn(payload,'expected'),'Expected answers leaked into inference input');
 check(payload.conversation.conversation_id!==c.id,'Descriptive case ID leaked into inference input');
 for(const expected of c.expected){
  const criterion=checklist.criteria.find(x=>x.id===expected.criterion_id);
  check(criterion?.allowed_values.includes(expected.value),'Illegal expected value');
  for(const id of [...(expected.acceptable_support_ids||[]),...(expected.must_check_message_ids||[])])check(conversation.transcript.some(m=>m.message_id===id),'Expected reference missing');
 }
 if(c.additional_criterion)check(Object.hasOwn(schema.properties.evaluations.anyOf[0].properties.criteria_by_id.properties,c.additional_criterion.id),'New criterion not in schema');
 requests.push({case_id:c.id,conversation,checklist,reference_text:c.reference_text||'',prompt_version:PROMPT_VERSION,schema_version:SCHEMA_VERSION,schema_hash:hash(schema),messages,response_format:{type:'json_schema',json_schema:{name:'cqa_readiness',strict:true,schema}},expected:c.expected,review_note:c.review_note||null});
}
// expected is an offline oracle alongside the prepared request. Only messages and
// response_format are model inputs; this script makes no network/model calls.
await writeFile(new URL('./prepared/requests.json',import.meta.url),JSON.stringify(requests,null,2));
const report={suite_version:suite.suite_version,notice:suite.notice,cases:requests.length,authored_expectations:requests.reduce((n,r)=>n+r.expected.length,0),languages:[...new Set(suite.cases.map(c=>c.language))],structural_assertions:assertions,model_calls:0,model_accuracy_measured:false,human_or_official_GT:false,prompt_version:PROMPT_VERSION,schema_version:SCHEMA_VERSION,case_manifest_sha256:hash(suite),prepared_requests:fileURLToPath(new URL('./prepared/requests.json',import.meta.url))};
await writeFile(new URL('./prepared/readiness-report.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
