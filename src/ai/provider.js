import { InputError, nonempty, hash } from '../domain.js';
import { SCHEMA_VERSION, buildReviewSchema, decodeSchemaResponse } from './schema.js';
import { aiFailure, cleanUsage, requestChat } from './transport.js';
import { SYSTEM_PROMPT } from './prompt.js';

export const PROMPT_VERSION = 'cqa-facts-1.6.1-contextual-recap';
export function providerConfig(env = process.env) {
  const config = { provider: env.AI_PROVIDER || '', baseUrl: env.AI_BASE_URL || '', model: env.AI_MODEL || '',
    apiKey: env.AI_API_KEY || '', timeoutMs: Number(env.AI_TIMEOUT_MS || 120000), jsonMode: env.AI_JSON_MODE !== 'false',
    protocol:env.AI_PROTOCOL || 'chat-compatible',
    responseFormat:env.AI_RESPONSE_FORMAT || (env.AI_JSON_MODE === 'false'?'none':'json_object'),
    reasoningEffort:env.AI_REASONING_EFFORT || null,
    maxCompletionTokens:env.AI_MAX_COMPLETION_TOKENS ? Number(env.AI_MAX_COMPLETION_TOKENS) : null };
  const missing = [];
  if (!['cloud', 'local'].includes(config.provider)) missing.push('AI_PROVIDER (cloud или local)');
  if (!nonempty(config.baseUrl)) missing.push('AI_BASE_URL');
  else { try { const u = new URL(config.baseUrl); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw Error(); }
    catch { missing.push('корректный AI_BASE_URL без пароля и параметров'); } }
  if (!nonempty(config.model)) missing.push('AI_MODEL');
  if (config.provider === 'cloud' && !nonempty(config.apiKey)) missing.push('AI_API_KEY');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 600000) missing.push('AI_TIMEOUT_MS (1000–600000)');
  if (!['chat-compatible','openai-chat'].includes(config.protocol)) missing.push('AI_PROTOCOL (chat-compatible или openai-chat)');
  if (!['json_schema','json_object','none'].includes(config.responseFormat)) missing.push('AI_RESPONSE_FORMAT (json_schema, json_object или none)');
  if (config.protocol !== 'openai-chat' && (config.reasoningEffort !== null || config.maxCompletionTokens !== null)) missing.push('OpenAI-параметры требуют явного AI_PROTOCOL=openai-chat');
  if (config.reasoningEffort !== null && !['none','minimal','low','medium','high','xhigh','max'].includes(config.reasoningEffort)) missing.push('допустимый AI_REASONING_EFFORT');
  if (/^(?:gpt-6-astra|gpt-6\.1-sol)(?:-|$)/.test(config.model) && ['none','minimal'].includes(config.reasoningEffort)) missing.push('Astra/Sol поддерживают reasoning от low до max');
  if (config.maxCompletionTokens !== null && (!Number.isInteger(config.maxCompletionTokens) || config.maxCompletionTokens < 1 || config.maxCompletionTokens > 128000)) missing.push('AI_MAX_COMPLETION_TOKENS (1–128000)');
  if (config.protocol === 'openai-chat' && config.maxCompletionTokens === null) missing.push('явный AI_MAX_COMPLETION_TOKENS для OpenAI');
  return { ...config, ready: missing.length === 0, missing };
}

export function buildMessages(conversation, checklist, referenceText = '', responseFormat = 'json_object') {
  // Deliberate text-only projection: signed audio links stay in the stored
  // Conversation for the UI and never enter the model request.
  const textConversation = {
    schema_version: conversation.schema_version,
    conversation_id: conversation.conversation_id,
    channel: conversation.channel,
    language: conversation.language,
    transcript: conversation.transcript.map(({ message_id, timestamp, speaker, text }) => ({ message_id, timestamp, speaker, text }))
  };
  return [
    { role:'system', content:SYSTEM_PROMPT },
    { role:'user', content:JSON.stringify({ checklist, conversation:textConversation, verified_reference:referenceText || null,
      ...(responseFormat==='json_schema'?{}:{output_schema:buildReviewSchema(checklist,conversation.channel,conversation)}) }) }
  ];
}

// Both cloud and local adapters use the OpenAI-compatible Chat Completions protocol.
// No fixtures, canned scores, automatic retry or hidden fallback are used here.
export function createProvider(config = providerConfig(), fetchImpl = fetch) {
  const identity={provider:config.provider,model:config.model,requested_model:config.model,returned_model:null,
    protocol:config.protocol,pipeline:'facts-then-evaluations',prompt_version:PROMPT_VERSION,prompt_hash:hash(SYSTEM_PROMPT),schema_version:SCHEMA_VERSION,
    response_format:config.responseFormat,reasoning_effort:config.reasoningEffort,max_completion_tokens:config.maxCompletionTokens,
    timeout_ms:config.timeoutMs,endpoint_hash:hash(config.baseUrl),attempts:0,calls:[],usage:null,elapsed_ms:0,finish_reason:null,cost_status:'not_calculated'};
  return {
    identity,
    async evaluate(conversation, checklist, referenceText = '') {
      const metadata=structuredClone(identity), started=Date.now();
      // Only public, bounded diagnostics are retained. Headers and raw responses are never logged.
      const safeText=value=>String(value)
        .split(config.apiKey || '\u0000').join('[REDACTED]')
        .split(conversation.audio_url || '\u0000').join('[AUDIO_URL_REDACTED]')
        .replace(/https?:\/\/\S*[?&](?:sig|token|key|signature)=[^\s]*/gi,'[SIGNED_URL_REDACTED]').slice(0,2000);
      let call;
      try {
        if (!config.ready) throw new InputError(`Модель не настроена: ${config.missing.join(', ')}. Заполните .env и перезапустите сервис.`,503);
        const schema=buildReviewSchema(checklist,conversation.channel,conversation);
        metadata.schema_hash=hash(schema); metadata.schema_snapshot=schema;
        const body={model:config.model,messages:buildMessages(conversation,checklist,referenceText,config.responseFormat),stream:false};
        if (config.responseFormat === 'json_schema') body.response_format={type:'json_schema',json_schema:{name:'cqa_facts_review',strict:true,schema}};
        if (config.responseFormat === 'json_object') body.response_format={type:'json_object'};
        if (config.protocol === 'openai-chat') {
          body.store=false;
          if (config.reasoningEffort !== null) body.reasoning_effort=config.reasoningEffort;
          body.max_completion_tokens=config.maxCompletionTokens;
        }
        call={attempt:1,stage:'facts-then-evaluations',provider:config.provider,protocol:config.protocol,requested_model:config.model,returned_model:null,
          response_format:config.responseFormat,prompt_version:PROMPT_VERSION,schema_version:SCHEMA_VERSION,schema_hash:metadata.schema_hash,
          reasoning_effort:config.reasoningEffort,max_completion_tokens:config.maxCompletionTokens,
          status:'started',http_status:null,finish_reason:null,refused:false,usage:null,elapsed_ms:0,error_code:null};
        metadata.calls.push(call); metadata.attempts=1;
        const payload=await requestChat(config,body,call,fetchImpl);
        call.returned_model=nonempty(payload?.model)?safeText(payload.model):null;
        call.usage=cleanUsage(payload?.usage);
        metadata.returned_model=call.returned_model; metadata.model=call.returned_model || config.model; metadata.usage=call.usage;
        const choice=payload?.choices?.[0];
        call.finish_reason=typeof choice?.finish_reason==='string' && ['stop','length','tool_calls','content_filter','function_call'].includes(choice.finish_reason)?choice.finish_reason:null;
        metadata.finish_reason=call.finish_reason;
        if (choice?.message?.refusal) {call.refused=true;throw aiFailure('AI отказался от оценки.','REFUSAL');}
        if (call.finish_reason==='length') throw aiFailure('Ответ AI обрезан лимитом токенов.','TRUNCATED');
        if (call.finish_reason!=='stop' || !nonempty(choice?.message?.content)) throw aiFailure('AI не завершил оценку: неподдерживаемый или пустой ответ.','INVALID_RESPONSE');
        let parsed;
        try { parsed=JSON.parse(choice.message.content); } catch { throw aiFailure('Содержимое ответа AI не является JSON. Оценка не завершена.','INVALID_JSON'); }
        const decoded=decodeSchemaResponse(parsed,checklist,conversation);
        if (decoded.limitation) throw aiFailure(`AI не смог завершить проверку: ${safeText(decoded.limitation)}`,'UNRESOLVED');
        const {review,dialogFacts}=decoded;
        call.facts_validation='accepted';metadata.dialog_facts_hash=hash(dialogFacts);
        call.status='parsed'; call.elapsed_ms=Date.now()-started; metadata.elapsed_ms=call.elapsed_ms;
        return {review,dialogFacts,metadata};
      } catch (e) {
        const error=e instanceof InputError ? e : aiFailure('Не удалось обработать ответ AI.','INVALID_RESPONSE');
        if (call) {call.status='failed';call.error_code=error.ai_code || 'INVALID_RESPONSE';call.elapsed_ms=Date.now()-started;}
        metadata.elapsed_ms=Date.now()-started;
        error.ai_metadata=metadata;
        throw error;
      }
    }
  };
}
