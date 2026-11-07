"""Reproduce planning costs; no network, model inference or application changes."""
from decimal import Decimal
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent


def main():
    models = json.loads((ROOT / 'model-candidates.json').read_text(encoding='utf-8'))['models']
    plan = json.loads((ROOT / 'model-experiment-plan.json').read_text(encoding='utf-8'))
    by_id = {m['api_model_id']: m for m in models if 'api_model_id' in m}
    result = {'is_estimate': True, 'currency': 'USD', 'prices_checked_on': plan['date'],
              'no_external_AI_calls': True, 'assumptions': {
                  'standard_tier': True, 'cache_tools_retries_discounts_taxes_included': False,
                  'reasoning_already_in_output_estimate': True,
                  'fixed_input_tokens_are_an_assumption_not_a_guarantee': True,
                  'per_call_output_cap': plan['per_call_output_cap_assumption'],
                  'repeat_scenario': 'Each of 3 models uses A2, 5 cases, 2 additional repeats',
                  'holdout_scenario': '2 expensive A2 finalists, 10 cases each; not an actual selection'},
              'per_model': {}}
    pilot = pilot_cap = repeats = repeats_cap = Decimal(0)
    expensive_a2 = []
    expensive_a2_cap = []
    for model_id in plan['model_ids']:
        model = by_id[model_id]
        rates = model['standard_usd_per_million']
        ri, ro = Decimal(str(rates['input'])), Decimal(str(rates['output_including_reasoning']))
        rows = {}
        subtotal = subtotal_cap = Decimal(0)
        for architecture in plan['architectures']:
            incoming = Decimal(architecture['input_tokens_estimate']) * ri
            cost = (incoming + Decimal(architecture['output_billed_tokens_estimate']) * ro) / 1000000
            capped = (incoming + Decimal(architecture['calls_per_evaluation'] * plan['per_call_output_cap_assumption']) * ro) / 1000000
            rows[architecture['id']] = {'estimated_usd_per_evaluation': str(cost), 'output_cap_scenario_usd_per_evaluation': str(capped)}
            subtotal += Decimal(plan['pilot_cases']) * cost
            subtotal_cap += Decimal(plan['pilot_cases']) * capped
            if architecture['id'] == 'A2':
                repeats += Decimal(10) * cost
                repeats_cap += Decimal(10) * capped
                expensive_a2.append(cost)
                expensive_a2_cap.append(capped)
        pilot += subtotal
        pilot_cap += subtotal_cap
        result['per_model'][model_id] = {'architectures': rows, 'pilot_estimated_usd': str(subtotal), 'pilot_output_cap_scenario_usd': str(subtotal_cap)}
    holdout = Decimal(10) * sum(sorted(expensive_a2, reverse=True)[:2])
    holdout_cap = Decimal(10) * sum(sorted(expensive_a2_cap, reverse=True)[:2])
    result['totals'] = {
        'pilot_estimated_usd': str(pilot), 'repeats_estimated_usd': str(repeats), 'holdout_estimated_usd': str(holdout),
        'complete_scenario_estimated_usd': str(pilot + repeats + holdout),
        'pilot_output_cap_scenario_usd': str(pilot_cap), 'repeats_output_cap_scenario_usd': str(repeats_cap),
        'holdout_output_cap_scenario_usd': str(holdout_cap), 'complete_output_cap_scenario_usd': str(pilot_cap + repeats_cap + holdout_cap),
        'pilot_calls': 180, 'repeats_calls_if_A2': 60, 'holdout_calls_if_A2': 40, 'complete_calls_if_A2': 280,
    }
    assert pilot == Decimal('41.80')
    assert repeats == Decimal('12.98')
    assert holdout == Decimal('11.80')
    assert pilot + repeats + holdout == Decimal('66.58')
    assert pilot_cap == Decimal('225.0688')
    assert pilot_cap + repeats_cap + holdout_cap == Decimal('368.5744')
    (ROOT / 'model-budget.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result['totals'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
