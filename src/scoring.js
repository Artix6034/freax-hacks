import { requireThat, validateChecklist, validateDecisionValue, reviewStatus } from './domain.js';

// Exact non-negative rational arithmetic; no intermediate binary-float rounding.
const gcd = (a, b) => b === 0n ? a : gcd(b, a % b);
const fraction = (n, d = 1n) => { const g = gcd(n, d); return [n / g, d / g]; };
const add = (a, b) => fraction(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const number = ([n, d]) => Number(n) / Number(d);
const halfUp = ([n, d]) => Number((n * 200n + d) / (d * 2n)) / 100;
const weightUnits = w => BigInt(Math.round(w * 1000));

export function calculate(checklist, review, channel) {
  validateChecklist(checklist);
  requireThat(Array.isArray(review?.criteria) && review.criteria.length === checklist.criteria.length, 'Нужен полный набор ответов для расчёта.');
  const byId = new Map(review.criteria.map(r => [r.criterion_id, r]));
  requireThat(byId.size === checklist.criteria.length && checklist.criteria.every(c => byId.has(c.id)), 'Дубли, пропуски или неизвестные критерии.');
  const unresolved=checklist.criteria.filter(c=>validateDecisionValue(c,byId.get(c.id),channel)==='unresolved');
  const blocked=unresolved.some(c=>c.type!=='flag' && c.weight>0);
  let earned = [0n, 1n], applicable = 0n;
  const rows = checklist.criteria.map(c => {
    const value = byId.get(c.id).value;
    const status=validateDecisionValue(c,byId.get(c.id),channel);
    const counted = status==='resolved' && c.type !== 'flag' && value !== 'na';
    const ratio = !counted ? null : c.type === 'scale' ? fraction(BigInt(value), BigInt(Math.max(...c.scale.map(s => s.value)))) : [value === 'yes' ? 1n : 0n, 1n];
    const w = weightUnits(c.weight);
    if (counted) { applicable += w; earned = add(earned, fraction(w * ratio[0], ratio[1])); }
    return { criterion_id: c.id, value, status, weight: c.weight, counted, ratio, raw_points:ratio?number(fraction(w*ratio[0],ratio[1]*1000n)):null };
  });
  const sections = [...new Set(checklist.criteria.filter(c => c.section).map(c => c.section))].map(section => {
    let points = [0n, 1n];
    let possible = 0n;
    for (const row of rows) {
      if (checklist.criteria.find(c => c.id === row.criterion_id).section !== section || !row.counted) continue;
      const w = weightUnits(row.weight); possible += w;
      points = add(points, fraction(w * row.ratio[0], row.ratio[1]));
    }
    return { section, contribution: blocked ? null : applicable > 0n ? number(fraction(100n * points[0], points[1] * applicable)) : 0,
      effective_weight: blocked ? null : applicable > 0n ? number(fraction(100n * possible, applicable)) : 0 };
  });
  return {
    total: blocked || applicable === 0n ? null : halfUp(fraction(100n * earned[0], earned[1] * applicable)),
    applicable_weight: blocked ? null : Number(applicable) / 1000,
    status:reviewStatus(review),resolved_count:rows.length-unresolved.length,unresolved_count:unresolved.length,unresolved_ids:unresolved.map(c=>c.id),
    total_reason:blocked?'Итог не рассчитан: есть неопределённые критерии с положительным весом.':applicable===0n?'Нет применимых критериев с положительным весом.':null,
    gross_error: checklist.criteria.some(c => c.type === 'flag' && byId.get(c.id).value === 'yes') ? true : unresolved.some(c=>c.type==='flag') ? null : false,
    rounding: 'ROUND_HALF_UP',
    sections,
    criteria: rows.map(({ ratio, ...r }) => ({ ...r, normalized: ratio ? number(ratio) : null,
      effective_weight: blocked ? null : r.counted && applicable > 0n ? number(fraction(100n * weightUnits(r.weight), applicable)) : 0,
      contribution: blocked ? null : ratio && applicable > 0n ? number(fraction(100n * weightUnits(r.weight) * ratio[0], applicable * ratio[1])) : 0 }))
  };
}
