"""Create explicitly artificial examples; no DEV dialog receives invented scores."""
import copy
from pathlib import Path

import compare_evaluations as metrics
from test_compare_evaluations import checklist, evaluation, expert, good_values


def main():
    config = checklist()
    folder = Path(__file__).resolve().parent / 'fixtures' / 'metrics'
    first = evaluation('artificial-metrics-001')
    second = evaluation('artificial-metrics-002')
    original_values = {**good_values(), '02': 'na', '03': 'na', '04': 15, '06': 7, '07': 'no'}
    original = [{'criterion_id': cid, 'value': value} for cid, value in original_values.items()]
    second['ai_review']['criteria'] = original
    second['original_score']['total'] = metrics.calculate_total(original_values, config)['value']
    final_values = {**original_values, '04': 20}
    second['final_review']['criteria'] = [{'criterion_id': cid, 'value': value} for cid, value in final_values.items()]
    second['final_score']['total'] = metrics.calculate_total(final_values, config)['value']
    reference_values = {**final_values, '08': 'yes'}
    refs = [expert('artificial-metrics-001'), expert('artificial-metrics-002', reference_values), expert('artificial-metrics-003-missing-ai')]
    # Match transcript hashes for the two artificial application snapshots.
    for raw, ref in zip([first, second], refs):
        ref['transcript_hash'] = metrics.normalize_record(raw, 'prediction', 'evaluation', 'original')['transcript_hash']
    metrics.write_json(folder / 'artificial-ai-evaluations.json', [first, second])
    metrics.write_json(folder / 'artificial-references.jsonl', refs, jsonl=True)
    print('Wrote 2 artificial Evaluation snapshots and 3 artificial references; no real-dialog labels.')


if __name__ == '__main__':
    main()
