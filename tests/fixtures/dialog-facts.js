// Synthetic mechanics fixture only, never labels, Ground Truth or a live result.
export function factsFixture(conversation) {
  const firstClient=conversation.transcript.find(m=>m.speaker==='client');
  return {client_language:{languages:firstClient?['RU']:[],certainty:firstClient?'supported':'uncertain',explanation:'TEST ONLY language observation',
    evidence:firstClient?[{message_id:firstClient.message_id,quote:firstClient.text}]:[]},
    first_operator_message_id:conversation.transcript.find(m=>m.speaker==='operator')?.message_id??null,
    client_questions:[],context_events:[],observations:[],limitations:['TEST ONLY fixture, no semantic extraction performed']};
}
export function reviewEnvelope(conversation,review) {
  return {dialog_facts:factsFixture(conversation),evaluations:{status:review.criteria.some(c=>c.status==='unresolved')?'partial':'completed',
    criteria_by_id:Object.fromEntries(review.criteria.map(c=>[c.criterion_id,c])),limitation:null}};
}
