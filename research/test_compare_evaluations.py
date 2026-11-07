"""All assigned scores below belong to artificial fixtures, never DEV dialogs."""
import contextlib
import copy
import io
import json
import math
from pathlib import Path
import tempfile
import unittest

import compare_evaluations as m


def checklist():
    return m.read_checklist(m.ROOT / 'config' / 'checklist.v1.json')


def good_values():
    return {'01': 'yes', '02': 'yes', '03': 'yes', '04': 20, '05': 'yes', '06': 10, '07': 'yes', '08': 'no'}


def expert(cid='artificial-001', values=None):
    c = checklist()
    values = good_values() if values is None else values
    raw = {'conversation_id': cid, 'reference_kind': 'artificial_fixture_not_ground_truth',
           'annotation_status': 'annotated', 'checklist_id': c['checklist_id'], 'checklist_version': c['version'],
           'criteria': [{'criterion_id': key, 'value': value, 'needs_adjudication': False} for key, value in values.items()],
           'total_score': None}
    return m.normalize_record(raw, 'reference', 'expert', 'original')


def prediction(cid='artificial-001', values=None, view='original_ai'):
    c = checklist()
    values = good_values() if values is None else values
    return {'format_version': m.FORMAT, 'record_kind': 'prediction', 'conversation_id': cid,
            'source_view': view, 'record_status': 'completed',
            'checklist_binding': {'checklist_id': c['checklist_id'], 'version': c['version']},
            'criteria': [{'criterion_id': key, 'value': value} for key, value in values.items()],
            'total_score': m.calculate_total({key: value for key, value in values.items() if value is not None and m.valid_value(value, next(x for x in c['criteria'] if x['id'] == key))}, c)['value']}


def evaluation(cid='artificial-001'):
    c = checklist()
    original = good_values()
    final = {**original, '01': 'no'}
    return {'schema_version': '1.0', 'evaluation_id': 'artificial-run-001', 'status': 'completed',
            'conversation': {'conversation_id': cid, 'language': 'EN', 'channel': 'agent chat', 'audio_url': None,
                             'transcript': [{'message_id': 'm0001', 'timestamp': '00:01', 'speaker': 'operator', 'text': 'Artificial fixture only.'}]},
            'checklist': c, 'ai_review': {'criteria': prediction(cid, original)['criteria']},
            'original_score': {'total': 100}, 'final_review': {'criteria': prediction(cid, final)['criteria']},
            'final_score': {'total': 90}}


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.config = checklist()

    def test_perfect_full_vector_and_totals(self):
        r = m.compare([prediction()], [expert()], self.config)
        self.assertEqual(r['summary']['full_vector_accuracy'], 1)
        self.assertEqual(r['totals']['mae'], 0)
        self.assertEqual(r['totals']['count'], 1)
        self.assertEqual(r['gross_error_flags']['08']['reference_labeled'], 1)

    def test_application_original_default_and_explicit_final(self):
        e = evaluation()
        original = m.normalize_records([e], 'prediction', 'evaluation')
        final = m.normalize_records([e], 'prediction', 'evaluation', 'reviewed-final')
        self.assertEqual(m.compare(original, [expert()], self.config)['criteria']['01']['accuracy'], 1)
        reviewed = m.compare(final, [expert()], self.config, 'reviewed-final')
        self.assertEqual(reviewed['criteria']['01']['accuracy'], 0)
        self.assertEqual(reviewed['totals']['mae'], 10)

    def test_no_fallback_to_human_final_if_original_absent(self):
        e = evaluation()
        e['ai_review'] = e['original_score'] = None
        r = m.compare(m.normalize_records([e], 'prediction', 'evaluation'), [expert()], self.config)
        self.assertEqual(r['criteria']['01']['prediction_missing'], 1)
        self.assertIsNone(r['totals']['mae'])

    def test_missing_prediction_reduces_exact_accuracy_without_fake_mae(self):
        r = m.compare([], [expert()], self.config)
        self.assertEqual(r['criteria']['01']['reference_labeled'], 1)
        self.assertEqual(r['criteria']['01']['accuracy'], 0)
        self.assertIsNone(r['totals']['mae'])
        self.assertEqual(r['totals']['counts']['reference_numeric_but_prediction_unavailable'], 1)

    def test_partial_reference_null_is_not_zero(self):
        truth = expert(values={**good_values(), '04': None})
        r = m.compare([prediction()], [truth], self.config)
        self.assertEqual(r['criteria']['04']['reference_labeled'], 0)
        self.assertIsNone(r['criteria']['04']['accuracy'])
        self.assertEqual(r['criteria']['01']['accuracy'], 1)
        self.assertEqual(r['totals']['count'], 0)
        self.assertIsNone(r['totals']['mae'])

    def test_unannotated_record_is_not_reference_even_if_some_values_filled(self):
        truth = expert()
        truth['annotation_status'] = 'unannotated'
        truth['total_score'] = 100
        r = m.compare([prediction()], [truth], self.config)
        self.assertEqual(r['status'], 'no_reference_annotations')
        self.assertIsNone(r['summary']['macro_criterion_accuracy'])
        self.assertEqual(r['totals']['count'], 0)

    def test_current_blank_pilot_is_structured_no_annotations(self):
        path = m.ROOT / 'research' / 'pilot20-expert-a.blank.jsonl'
        refs = m.normalize_records(m.load_records(path), 'reference', 'expert')
        r = m.compare([], refs, self.config)
        self.assertEqual(r['status'], 'no_reference_annotations')
        self.assertEqual(r['coverage']['reference_records'], 20)
        self.assertEqual(r['criteria']['04']['reference_unlabeled'], 20)
        self.assertIsNone(r['criteria']['04']['numeric_scale']['mae'])
        self.assertEqual(r['totals']['count'], 0)

    def test_na_errors_include_unavailable_and_do_not_inflate_numeric_mae(self):
        refs = [expert('artificial-na-1', {**good_values(), '02': 'na'}),
                expert('artificial-na-2', {**good_values(), '02': 'no'}),
                expert('artificial-na-3', {**good_values(), '02': 'na'})]
        preds = [prediction('artificial-na-1'), prediction('artificial-na-2', {**good_values(), '02': 'na'})]
        stat = m.compare(preds, refs, self.config)['criteria']['02']
        self.assertEqual(stat['reference_labeled'], 3)
        self.assertEqual(stat['accuracy'], 0)
        self.assertEqual(stat['na_selection']['fp'], 1)
        self.assertEqual(stat['na_selection']['fn_including_unavailable'], 2)
        self.assertEqual(stat['na_selection']['prediction_unavailable'], 1)
        truth = expert(values={**good_values(), '04': 'na'})
        stat = m.compare([prediction()], [truth], self.config)['criteria']['04']
        self.assertEqual(stat['accuracy'], 0)
        self.assertEqual(stat['numeric_scale']['count'], 0)
        self.assertIsNone(stat['numeric_scale']['mae'])

    def test_scale_mae_has_explicit_numeric_pair_count(self):
        p = prediction(values={**good_values(), '04': 15, '06': 4})
        r = m.compare([p], [expert()], self.config)
        self.assertEqual(r['criteria']['04']['numeric_scale']['mae'], 5)
        self.assertEqual(r['criteria']['06']['numeric_scale']['mae'], 6)
        self.assertEqual(r['criteria']['06']['numeric_scale']['count'], 1)

    def test_reported_total_errors_not_replaced_by_recalculation(self):
        half = {'01': 'yes', '02': 'yes', '03': 'yes', '04': 0, '05': 'no', '06': 0, '07': 'yes', '08': 'no'}
        refs = [expert('artificial-total-1'), expert('artificial-total-2', half)]
        preds = [prediction('artificial-total-1'), prediction('artificial-total-2', half)]
        preds[0]['total_score'], preds[1]['total_score'] = 90, 80
        r = m.compare(preds, refs, self.config)
        self.assertEqual(r['totals']['mae'], 20)
        self.assertAlmostEqual(r['totals']['rmse'], math.sqrt(500))
        self.assertEqual(r['totals']['bias_prediction_minus_reference'], 10)
        self.assertEqual(r['totals']['counts']['prediction_arithmetic_mismatch'], 2)
        self.assertEqual(r['summary']['full_vector_accuracy'], 1)

    def test_inconsistent_declared_reference_total_is_not_silently_fixed(self):
        truth = expert()
        truth['total_score'] = 75
        r = m.compare([prediction()], [truth], self.config)
        self.assertEqual(r['totals']['count'], 0)
        self.assertEqual(r['per_dialog'][0]['reference_total']['status'], 'inconsistent_declared_reference_total')
        self.assertEqual(len(r['errors_by_dialog']), 1)

    def test_duplicate_dialogs_and_duplicate_criteria_rejected(self):
        with self.assertRaises(m.FormatError):
            m.normalize_records([prediction(), prediction()], 'prediction', 'internal')
        with self.assertRaises(m.FormatError):
            m.compare([], [expert(), expert()], self.config)
        p = prediction()
        p['criteria'].append(copy.deepcopy(p['criteria'][0]))
        with self.assertRaises(m.FormatError):
            m.normalize_records([p], 'prediction', 'internal')

    def test_invalid_values_are_unavailable_not_zero(self):
        p = prediction()
        next(c for c in p['criteria'] if c['criterion_id'] == '04')['value'] = True
        next(c for c in p['criteria'] if c['criterion_id'] == '06')['value'] = 8
        next(c for c in p['criteria'] if c['criterion_id'] == '01')['value'] = 'na'
        r = m.compare([p], [expert()], self.config)
        self.assertEqual(r['criteria']['04']['prediction_invalid'], 1)
        self.assertEqual(r['criteria']['06']['accuracy'], 0)
        self.assertEqual(r['criteria']['01']['prediction_invalid'], 1)
        self.assertEqual(r['totals']['count'], 0)

    def test_pending_adjudication_excluded_per_criterion(self):
        truth = expert()
        next(c for c in truth['criteria'] if c['criterion_id'] == '04')['needs_adjudication'] = True
        r = m.compare([prediction()], [truth], self.config)
        self.assertEqual(r['criteria']['04']['reference_pending'], 1)
        self.assertIsNone(r['criteria']['04']['accuracy'])
        self.assertEqual(r['criteria']['01']['accuracy'], 1)

    def test_failed_prediction_is_not_saved_by_present_values(self):
        p = prediction()
        p['record_status'] = 'failed'
        r = m.compare([p], [expert()], self.config)
        self.assertEqual(r['criteria']['01']['prediction_failed'], 1)
        self.assertIsNone(r['totals']['mae'])

    def test_partial_prediction_keeps_known_answers_and_abstains_on_unknown(self):
        p = prediction()
        p['record_status'] = 'partial'
        p['total_score'] = None
        row = next(c for c in p['criteria'] if c['criterion_id'] == '04')
        row.update(status='unresolved', value=None)
        r = m.compare([p], [expert()], self.config, derive_prediction_total=True)
        self.assertEqual(r['criteria']['01']['accuracy'], 1)
        self.assertEqual(r['criteria']['01']['prediction_failed'], 0)
        self.assertEqual(r['criteria']['04']['prediction_unresolved'], 1)
        self.assertEqual(r['criteria']['04']['confusion_matrix']['counts']['20'], {'__unresolved__': 1})
        self.assertEqual(r['criteria']['04']['numeric_scale']['count'], 0)
        self.assertEqual(r['summary']['full_vector_accuracy'], 0)
        self.assertEqual(r['coverage']['prediction_record_statuses'], {'partial': 1})
        self.assertEqual(r['per_dialog'][0]['prediction_total_status'], 'unresolved_weighted_labels')
        self.assertEqual(r['totals']['count'], 0)

    def test_partial_weighted_unknown_cannot_report_a_rescaled_total(self):
        p = prediction()
        p['record_status'] = 'partial'
        next(c for c in p['criteria'] if c['criterion_id'] == '04').update(status='unresolved', value=None)
        r = m.compare([p], [expert()], self.config)
        self.assertEqual(r['per_dialog'][0]['prediction_total_status'], 'incomplete_prediction_labels')
        self.assertEqual(r['per_dialog'][0]['prediction_unresolved_weighted_ids'], ['04'])
        self.assertIsNone(r['per_dialog'][0]['prediction_total'])
        self.assertEqual(r['totals']['count'], 0)

    def test_partial_unknown_flag_preserves_total_and_does_not_become_no(self):
        p = prediction()
        p['record_status'] = 'partial'
        next(c for c in p['criteria'] if c['criterion_id'] == '08').update(status='unresolved', value=None)
        r = m.compare([p], [expert()], self.config)
        self.assertEqual(r['totals']['count'], 1)
        self.assertEqual(r['totals']['mae'], 0)
        self.assertEqual(r['gross_error_flags']['08']['prediction_unresolved'], 1)
        self.assertEqual(r['gross_error_flags']['08']['accuracy'], 0)
        self.assertEqual(r['summary']['full_vector_accuracy'], 0)

    def test_unresolved_row_with_a_value_is_invalid_and_not_used_for_total(self):
        p = prediction()
        p['record_status'] = 'partial'
        next(c for c in p['criteria'] if c['criterion_id'] == '04')['status'] = 'unresolved'
        r = m.compare([p], [expert()], self.config)
        self.assertEqual(r['criteria']['04']['prediction_invalid'], 1)
        self.assertEqual(r['criteria']['04']['prediction_unresolved'], 0)
        self.assertEqual(r['totals']['count'], 0)

    def test_appealed_partial_keeps_original_and_final_statuses_separate(self):
        app = evaluation()
        app.update(ai_status='partial', final_status='completed', status='completed')
        next(c for c in app['ai_review']['criteria'] if c['criterion_id'] == '04').update(status='unresolved', value=None)
        app['original_score']['total'] = None
        original = m.normalize_record(app, 'prediction', 'evaluation', 'original')
        final = m.normalize_record(app, 'prediction', 'evaluation', 'reviewed-final')
        self.assertEqual(original['record_status'], 'partial')
        self.assertEqual(final['record_status'], 'completed')
        before = m.compare([original], [expert()], self.config)
        after = m.compare([final], [expert()], self.config, 'reviewed-final')
        self.assertEqual(before['criteria']['04']['prediction_unresolved'], 1)
        self.assertEqual(before['totals']['count'], 0)
        self.assertEqual(after['criteria']['04']['accuracy'], 1)
        self.assertEqual(after['totals']['count'], 1)

    def test_legacy_partial_original_is_inferred_from_original_review_only(self):
        app = evaluation()
        next(c for c in app['ai_review']['criteria'] if c['criterion_id'] == '04').update(status='unresolved', value=None)
        app['original_score']['total'] = None
        original = m.normalize_record(app, 'prediction', 'evaluation', 'original')
        final = m.normalize_record(app, 'prediction', 'evaluation', 'reviewed-final')
        self.assertEqual(original['record_status'], 'partial')
        self.assertEqual(final['record_status'], 'completed')

    def test_explicit_failed_original_is_not_rescued_by_reviewed_status(self):
        app = evaluation()
        app.update(ai_status='failed', final_status='completed')
        original = m.normalize_record(app, 'prediction', 'evaluation', 'original')
        r = m.compare([original], [expert()], self.config)
        self.assertEqual(r['criteria']['01']['prediction_failed'], 1)
        self.assertEqual(r['totals']['count'], 0)

    def test_partial_internal_conversion_preserves_status_without_private_explanation(self):
        p = prediction()
        p['record_status'] = 'partial'
        row = next(c for c in p['criteria'] if c['criterion_id'] == '04')
        row.update(status='unresolved', value=None, missing_information=['PRIVATE_FACT'], explanation='PRIVATE_REASON')
        result = m.normalize_record(p, 'prediction', 'internal', 'original')
        self.assertEqual(next(c for c in result['criteria'] if c['criterion_id'] == '04')['status'], 'unresolved')
        self.assertNotIn('PRIVATE_FACT', json.dumps(result))
        self.assertNotIn('PRIVATE_REASON', json.dumps(result))

    def test_missing_flag_does_not_become_no_and_does_not_block_numeric_total(self):
        truth = expert(values={**good_values(), '08': None})
        r = m.compare([prediction()], [truth], self.config)
        self.assertIsNone(r['gross_error_flags']['08']['accuracy'])
        self.assertEqual(r['totals']['mae'], 0)
        self.assertEqual(r['summary']['fully_labeled_dialogs'], 0)

    def test_flag_false_negative_is_visible_even_with_perfect_total(self):
        truth = expert(values={**good_values(), '08': 'yes'})
        r = m.compare([prediction()], [truth], self.config)
        self.assertEqual(r['totals']['mae'], 0)
        self.assertEqual(r['gross_error_flags']['08']['yes_metrics']['fn_including_unavailable'], 1)

    def test_view_mixing_and_checklist_mismatch(self):
        with self.assertRaises(m.FormatError):
            m.normalize_records([prediction(view='reviewed_final')], 'prediction', 'internal', 'original')
        p = prediction()
        p['checklist_binding']['version'] += 1
        r = m.compare([p], [expert()], self.config)
        self.assertEqual(r['criteria']['01']['prediction_incompatible'], 1)
        self.assertEqual(r['criteria']['01']['accuracy'], 0)
        self.assertEqual(r['totals']['count'], 0)

    def test_transcript_mismatch_prevents_numeric_comparison(self):
        truth, p = expert(), prediction()
        truth['transcript_hash'], p['transcript_hash'] = 'artificial-hash-a', 'artificial-hash-b'
        r = m.compare([p], [truth], self.config)
        self.assertEqual(r['criteria']['01']['prediction_incompatible'], 1)
        self.assertEqual(r['totals']['count'], 0)

    def test_missing_ai_total_is_derived_only_with_explicit_option(self):
        p = prediction()
        p['total_score'] = None
        self.assertEqual(m.compare([p], [expert()], self.config)['totals']['count'], 0)
        r = m.compare([p], [expert()], self.config, derive_prediction_total=True)
        self.assertEqual(r['totals']['mae'], 0)
        self.assertEqual(r['per_dialog'][0]['prediction_total_source'], 'explicitly_derived_from_prediction_labels')

    def test_na_arithmetic_fixture_and_half_up(self):
        values = {**good_values(), '02': 'na', '03': 'na', '04': 15, '06': 7}
        self.assertEqual(m.calculate_total(values, self.config)['value'], 85.38)
        custom = {'criteria': [{'id': 'x', 'type': 'scale', 'weight': 1, 'scale': [{'value': 0}, {'value': 20000}]}]}
        self.assertEqual(m.calculate_total({'x': 17531}, custom)['value'], 87.66)

    def test_cli_conversion_and_comparison(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            app, internal, refs, report = [root / name for name in ('app.json', 'internal.jsonl', 'refs.json', 'report.json')]
            m.write_json(app, [evaluation()])
            m.write_json(refs, [expert()])
            with contextlib.redirect_stdout(io.StringIO()):
                code = m.main(['convert', '--kind', 'prediction', '--format', 'evaluation', '--input', str(app), '--output', str(internal)])
                self.assertEqual(code, 0)
                code = m.main(['compare', '--prediction-format', 'internal', '--predictions', str(internal), '--references', str(refs), '--reference-format', 'internal', '--output', str(report)])
                self.assertEqual(code, 0)
            self.assertEqual(m.load_records(internal)[0]['source_view'], 'original_ai')
            self.assertEqual(json.loads(report.read_text(encoding='utf-8'))['totals']['mae'], 0)

    def test_all_na_has_legitimate_null_total_not_zero(self):
        custom = {'checklist_id': 'artificial-all-na', 'version': 1, 'criteria': [
            {'id': 'x', 'type': 'boolean', 'weight': 1, 'allowed_values': ['yes', 'no', 'na'], 'scale': []}]}
        ref = {'conversation_id': 'artificial-all-na-001', 'annotation_status': 'annotated',
               'criteria': [{'criterion_id': 'x', 'value': 'na'}], 'total_score': None}
        pred = {'conversation_id': 'artificial-all-na-001', 'source_view': 'original_ai', 'record_status': 'completed',
                'criteria': [{'criterion_id': 'x', 'value': 'na'}], 'total_score': None}
        result = m.compare([pred], [ref], custom)
        self.assertEqual(result['totals']['count'], 0)
        self.assertIsNone(result['totals']['mae'])
        self.assertEqual(result['totals']['counts']['null_total_availability_matches'], 1)
        pred['total_score'] = 0
        result = m.compare([pred], [ref], custom)
        self.assertEqual(result['totals']['counts']['null_total_availability_errors'], 1)
        self.assertEqual(len(result['errors_by_dialog']), 1)

    def test_conversion_discards_private_quotes_and_signed_urls(self):
        app = evaluation()
        app['conversation']['audio_url'] = 'https://private.invalid/?sig=secret'
        app['ai_review']['criteria'][0]['evidence'] = [{'message_id': 'm0001', 'quote': 'PRIVATE_QUOTE'}]
        output = json.dumps(m.normalize_record(app, 'prediction', 'evaluation', 'original'))
        self.assertNotIn('PRIVATE_QUOTE', output)
        self.assertNotIn('private.invalid', output)

    def test_baseline_template_is_not_mistaken_for_application_or_expert(self):
        archived = {'checklist_hash': 'artificial', 'records': [{'conversation_id': 'artificial', 'findings': []}]}
        with self.assertRaises(m.FormatError):
            m.normalize_records([archived], 'reference', 'expert')

    def test_nonstandard_nan_json_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'nan.json'
            path.write_text('{"conversation_id":"artificial","value":NaN}', encoding='utf-8')
            with self.assertRaises(m.FormatError):
                m.load_records(path)


if __name__ == '__main__':
    unittest.main()
