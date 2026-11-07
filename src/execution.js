import {hash} from './domain.js';
import {PROMPT_VERSION} from './ai/provider.js';
import {SYSTEM_PROMPT} from './ai/prompt.js';
import {SCHEMA_VERSION} from './ai/schema.js';

// Only public configuration: never base URL, key, headers, or signed media URLs.
export function executionSnapshot(identity={},checklist,referenceText='',referenceVersion=''){
  return {provider:identity?.provider??null,requested_model:identity?.requested_model??identity?.model??null,
    protocol:identity?.protocol??null,endpoint_hash:identity?.endpoint_hash??null,prompt_version:identity?.prompt_version??PROMPT_VERSION,prompt_hash:identity?.prompt_hash??hash(SYSTEM_PROMPT),
    schema_version:identity?.schema_version??SCHEMA_VERSION,response_format:identity?.response_format??null,
    reasoning_effort:identity?.reasoning_effort??null,max_completion_tokens:identity?.max_completion_tokens??null,timeout_ms:identity?.timeout_ms??null,
    checklist_id:checklist.checklist_id,checklist_version:checklist.version,checklist_hash:hash(checklist),
    reference_hash:hash(referenceText),reference_version:referenceVersion||`sha256:${hash(referenceText)}`};
}

export function legacyExecutionKey(record){
  if(record.configuration_hash)return record.configuration_hash;
  return hash({prompt_version:record.prompt_version??record.ai_metadata?.prompt_version??null,
    prompt_hash:record.ai_metadata?.prompt_hash??null,schema_version:record.ai_metadata?.schema_version??null,
    requested_model:record.ai_metadata?.requested_model??record.ai_metadata?.model??null,provider:record.ai_metadata?.provider??null,
    protocol:record.ai_metadata?.protocol??null,response_format:record.ai_metadata?.response_format??null,
    reasoning_effort:record.ai_metadata?.reasoning_effort??null,max_completion_tokens:record.ai_metadata?.max_completion_tokens??null,
    reference_hash:record.reference_hash??null,checklist_hash:hash(record.checklist)});
}
