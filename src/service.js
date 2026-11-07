import { randomUUID } from 'node:crypto';
import { hash, normalizeConversation, validateChecklist, validateReview, reviewStatus, InputError, requireThat, nonempty } from './domain.js';
import { calculate } from './scoring.js';
import { PROMPT_VERSION } from './ai/provider.js';
import { validateDialogFacts } from './ai/facts.js';
import {executionSnapshot} from './execution.js';

export class EvaluationService {
  constructor(store, provider, referenceText = '', referenceVersion = '') { Object.assign(this, { store, provider, referenceText, referenceVersion }); }
  configuration(checklist){return executionSnapshot(this.provider.identity,checklist,this.referenceText,this.referenceVersion);}
  async evaluate(input, checklist, context={}) {
    const conversation = normalizeConversation(input);
    requireThat(conversation.transcript.some(m => m.speaker === 'operator'), 'В диалоге нет сообщений оператора для оценки.');
    validateChecklist(checklist);
    const execution=this.configuration(checklist);
    const record = { schema_version: '1.0', evaluation_id: randomUUID(), created_at: new Date().toISOString(),
      run_id:context.runId??null,execution_snapshot:execution,configuration_hash:hash(execution),execution_pid:process.pid,
      status: 'running', ai_status:'running', final_status:'running', revision: 1, conversation, conversation_hash: hash(conversation),
      checklist: structuredClone(checklist), checklist_hash: hash(checklist), reference_hash: hash(this.referenceText),
      reference_snapshot:{version:this.referenceVersion || `sha256:${hash(this.referenceText)}`,text:this.referenceText},
      prompt_version: PROMPT_VERSION, ai_metadata: structuredClone(this.provider.identity ?? null), ai_facts:null, ai_review: null, original_score: null, final_review: null, final_score: null, appeals: [] };
    await this.store.write(record.evaluation_id, record);
    if(context.onCreated)await context.onCreated(record.evaluation_id);
    try {
      const { review, dialogFacts, metadata } = await this.provider.evaluate(conversation, checklist, this.referenceText);
      record.ai_metadata=metadata;
      // Legacy/custom providers may lack facts; the production adapter always requires them.
      if(dialogFacts!==undefined)validateDialogFacts(dialogFacts,conversation);
      validateReview(review, checklist, conversation);
      if (metadata?.calls?.[0]) metadata.calls[0].review_validation='accepted';
      record.ai_review = review;
      record.ai_facts = dialogFacts===undefined?null:structuredClone(dialogFacts);
      record.original_score = calculate(checklist, review,conversation.channel);
      record.final_review = structuredClone(review); record.final_score = structuredClone(record.original_score);
      record.ai_status=reviewStatus(review);record.final_status=record.ai_status;record.status=record.final_status; record.completed_at = new Date().toISOString();
    } catch (e) {
      if (e.ai_metadata) record.ai_metadata=e.ai_metadata;
      else if (record.ai_metadata?.calls?.[0]) record.ai_metadata.calls[0].review_validation='rejected';
      record.status = 'failed';record.ai_status='failed';record.final_status='failed'; record.error = e instanceof InputError ? e.message : 'Внутренняя ошибка оценки.';
      record.failed_at = new Date().toISOString();
    }
    await this.store.write(record.evaluation_id, record);
    return record;
  }
  async appeal(id, input) {
    return this.store.transaction(async () => {
      const r = await this.store.read(id);
      requireThat(['completed','partial'].includes(r.status), 'Апелляция доступна после полной или частичной оценки.');
      requireThat(r.revision === input.revision, 'Результат уже изменился. Обновите карточку.');
      requireThat(r.checklist.criteria.some(c => c.id === input.criterion_id) && nonempty(input.comment), 'Нужны критерий и комментарий.');
      requireThat(!r.appeals.some(a => a.criterion_id === input.criterion_id && a.status === 'pending'), 'По критерию уже есть открытая апелляция.');
      r.appeals.push({ appeal_id: randomUUID(), criterion_id: input.criterion_id, comment: input.comment,
        status: 'pending', created_at: new Date().toISOString(), disputed_review: structuredClone(r.final_review.criteria.find(c => c.criterion_id === input.criterion_id)) });
      r.revision++;
      return this.store.write(id, r);
    });
  }
  async resolve(id, input) {
    return this.store.transaction(async () => {
      const r = await this.store.read(id);
      requireThat(['completed','partial'].includes(r.status) && r.revision === input.revision, 'Результат изменился или не готов. Обновите карточку.');
      const a = r.appeals.find(a => a.appeal_id === input.appeal_id && a.status === 'pending');
      requireThat(a && nonempty(input.reason) && ['confirm', 'change'].includes(input.action), 'Нужны открытая апелляция, действие и причина.');
      const final = structuredClone(r.final_review);
      const index = final.criteria.findIndex(c => c.criterion_id === a.criterion_id);
      if (input.action === 'change') {
        requireThat(input.review?.criterion_id === a.criterion_id, 'Решение относится к другому критерию.');
        final.criteria[index] = input.review;
      }
      validateReview(final, r.checklist, r.conversation);
      a.status = 'resolved'; a.resolved_at = new Date().toISOString(); a.action = input.action; a.reason = input.reason;
      a.decision_review = structuredClone(final.criteria[index]);
      r.ai_status ??= r.ai_review ? reviewStatus(r.ai_review) : 'failed';
      r.final_review = final; r.final_score = calculate(r.checklist, final,r.conversation.channel);
      r.final_status=reviewStatus(final);r.status=r.final_status;r.revision++;
      return this.store.write(id, r);
    });
  }
}
