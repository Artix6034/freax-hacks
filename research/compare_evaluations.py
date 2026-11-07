"""Internal CQA diagnostics, standard library only; never an official jury metric."""
import argparse
from collections import Counter
from fractions import Fraction
from hashlib import sha256
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
FORMAT = 'cqa-comparison-1'
VIEWS = {'original': 'original_ai', 'reviewed-final': 'reviewed_final'}
READY_REFERENCE = {'annotated', 'adjudicated', 'final', 'partial', 'needs_adjudication'}
UNAVAILABLE = {'missing': '__missing__', 'unresolved': '__unresolved__', 'invalid': '__invalid__', 'failed': '__failed__', 'incompatible': '__incompatible__'}


class FormatError(ValueError):
    pass


def canonical_hash(value):
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()


def reject_constant(value):
    raise FormatError('NaN/Infinity are not valid JSON numbers.')


def load_records(path):
    path = Path(path)
    text = path.read_text(encoding='utf-8-sig')
    try:
        if path.suffix.lower() == '.jsonl':
            records = [json.loads(line, parse_constant=reject_constant) for line in text.splitlines() if line.strip()]
        else:
            value = json.loads(text, parse_constant=reject_constant)
            records = value if isinstance(value, list) else [value]
    except json.JSONDecodeError as exc:
        raise FormatError(f'Invalid JSON in {path.name}, line {exc.lineno}, column {exc.colno}') from None
    if not all(isinstance(r, dict) for r in records):
        raise FormatError('Each input record must be an object; use full Evaluation objects, not summary rows.')
    return records


def write_json(path, value, jsonl=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if jsonl:
        text = ''.join(json.dumps(row, ensure_ascii=False, allow_nan=False) + '\n' for row in value)
    else:
        text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    path.write_text(text, encoding='utf-8')


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def valid_value(value, criterion):
    if type(value) is str:
        return value in criterion['allowed_values']
    return numeric(value) and any(numeric(v) and value == v for v in criterion['allowed_values'])


def read_checklist(path):
    config = json.loads(Path(path).read_text(encoding='utf-8-sig'), parse_constant=reject_constant)
    rows = config.get('criteria')
    if not isinstance(rows, list) or not rows:
        raise FormatError('Checklist must contain a nonempty criteria array.')
    seen = set()
    for c in rows:
        if not isinstance(c.get('id'), str) or c['id'] in seen:
            raise FormatError('Checklist criterion IDs must be unique strings.')
        seen.add(c['id'])
        if c.get('type') not in {'boolean', 'scale', 'flag'} or not isinstance(c.get('allowed_values'), list):
            raise FormatError('Unsupported checklist criterion type/values.')
        if not numeric(c.get('weight')) or c['weight'] < 0:
            raise FormatError('Checklist weights must be finite nonnegative numbers.')
        if c['type'] == 'scale' and not c.get('scale'):
            raise FormatError('Scale criterion must declare scale steps.')
        if c['type'] == 'scale' and (not all(numeric(s.get('value')) for s in c['scale']) or min(s['value'] for s in c['scale']) != 0 or max(s['value'] for s in c['scale']) <= 0):
            raise FormatError('This adapter supports scales beginning at zero with a positive maximum.')
        if c['type'] == 'flag' and c['weight'] != 0:
            raise FormatError('Flags must have zero weight.')
    return config


def binding(record):
    version = record.get('checklist_version')
    # Explicit legacy adapter for the blank forms prepared from the initial PDF.
    if version == 'initial-pdf-v1':
        return {'checklist_id': 'freedom-chat', 'version': 1}
    cid = record.get('checklist_id')
    return {'checklist_id': cid, 'version': version} if cid is not None or version is not None else None


def selected_status(record, review, view):
    """Keep the immutable machine result separate from an appealed final result."""
    field = 'ai_status' if view == 'original' else 'final_status'
    if field in record:
        return record[field]
    # A legacy failed run is not rescued by stray criterion values.
    if record.get('status') in {'failed', 'running'}:
        return record['status']
    if isinstance(review, dict) and review.get('criteria'):
        return 'partial' if any(c.get('status') == 'unresolved' for c in review['criteria']) else 'completed'
    return record.get('status')


def criterion_state(row, criterion):
    """An abstention is neither N/A nor a missing/invalid model response."""
    status = row.get('status', 'resolved')
    if status == 'unresolved':
        return 'unresolved' if row.get('value') is None else 'invalid'
    if status != 'resolved':
        return 'invalid'
    if row.get('value') is None:
        return 'missing'
    return 'valid' if valid_value(row['value'], criterion) else 'invalid'


def normalize_record(record, kind, input_format, view):
    if input_format == 'internal':
        if record.get('format_version') != FORMAT or record.get('record_kind') != kind:
            raise FormatError('Internal format requires format_version=cqa-comparison-1 and the correct record_kind.')
        result = dict(record)
        if kind == 'prediction' and result.get('source_view') != VIEWS[view]:
            raise FormatError('Prediction source_view differs from --view; original and reviewed results cannot be mixed.')
    elif input_format == 'evaluation':
        if kind != 'prediction' or not isinstance(record.get('conversation'), dict) or 'ai_review' not in record:
            raise FormatError('Expected a full application Evaluation with conversation and ai_review.')
        review_key, score_key = ('ai_review', 'original_score') if view == 'original' else ('final_review', 'final_score')
        review, score = record.get(review_key), record.get(score_key)
        checklist = record.get('checklist') or {}
        conversation = record['conversation']
        transcript = conversation.get('transcript')
        transcript_hash = None
        if isinstance(transcript, list) and all(isinstance(m, dict) and all(k in m for k in ('timestamp', 'speaker', 'text')) for m in transcript):
            transcript_hash = canonical_hash([{k: m[k] for k in ('timestamp', 'speaker', 'text')} for m in transcript])
        result = {
            'format_version': FORMAT, 'record_kind': kind, 'conversation_id': conversation.get('conversation_id'),
            'evaluation_id': record.get('evaluation_id'), 'source_view': VIEWS[view],
            'record_status': selected_status(record, review, view), 'criteria': review.get('criteria', []) if isinstance(review, dict) else [],
            'total_score': score.get('total') if isinstance(score, dict) else None,
            'checklist_binding': {'checklist_id': checklist.get('checklist_id'), 'version': checklist.get('version')},
            'checklist_fingerprint': canonical_hash(checklist) if checklist else None,
            'transcript_hash': transcript_hash,
        }
    elif input_format == 'expert':
        if kind != 'reference' or 'criteria' not in record:
            raise FormatError('Expected an expert annotation object with criteria.')
        result = dict(record)
        result.update({'format_version': FORMAT, 'record_kind': kind, 'checklist_binding': binding(record)})
    else:
        raise FormatError('Unsupported input format for this record kind.')
    if not isinstance(result.get('conversation_id'), str) or not result['conversation_id'].strip():
        raise FormatError('Every record needs a nonempty conversation_id.')
    if not isinstance(result.get('criteria'), list):
        raise FormatError('criteria must be an array.')
    seen = set()
    for criterion in result['criteria']:
        if not isinstance(criterion, dict) or not isinstance(criterion.get('criterion_id'), str) or criterion['criterion_id'] in seen:
            raise FormatError('Each record must have unique string criterion_id values.')
        seen.add(criterion['criterion_id'])
    # Metrics need values and provenance, not transcript text, private quotes,
    # signed audio URLs or reviewer free-text notes. Keep source files intact.
    result['criteria'] = [{'criterion_id': c['criterion_id'], 'value': c.get('value'), 'status': c.get('status', 'resolved'),
                           'needs_adjudication': c.get('needs_adjudication')} for c in result['criteria']]
    keys = {'format_version', 'record_kind', 'conversation_id', 'evaluation_id', 'source_view',
            'record_status', 'annotation_status', 'reference_kind', 'criteria', 'total_score',
            'checklist_binding', 'checklist_fingerprint', 'transcript_hash', 'language', 'channel'}
    return {key: value for key, value in result.items() if key in keys}


def normalize_records(records, kind, input_format, view='original'):
    rows = [normalize_record(r, kind, input_format, view) for r in records]
    ids = [r['conversation_id'] for r in rows]
    if len(set(ids)) != len(ids):
        raise FormatError('Duplicate conversation_id: choose one AI run or one adjudicated reference per dialog; do not combine experts or revisions.')
    return rows


def label(value):
    return str(int(value)) if numeric(value) and value == int(value) else str(value)


def ratio(n, d):
    return n / d if d else None


def error_metrics(errors):
    return {'count': len(errors), 'mae': sum(abs(e) for e in errors) / len(errors) if errors else None,
            'rmse': math.sqrt(sum(e * e for e in errors) / len(errors)) if errors else None,
            'bias_prediction_minus_reference': sum(errors) / len(errors) if errors else None,
            'max_absolute_error': max(map(abs, errors)) if errors else None}


def calculate_total(values, checklist):
    weighted = [c for c in checklist['criteria'] if c['type'] != 'flag' and c['weight'] > 0]
    if any(c['id'] not in values for c in weighted):
        return {'status': 'missing_weighted_labels', 'value': None}
    earned, applicable = Fraction(0), Fraction(0)
    for c in weighted:
        value = values[c['id']]
        if value == 'na':
            continue
        weight = Fraction(str(c['weight']))
        if c['type'] == 'scale':
            quality = Fraction(str(value)) / max(Fraction(str(s['value'])) for s in c['scale'])
        else:
            quality = Fraction(1 if value == 'yes' else 0)
        applicable += weight
        earned += weight * quality
    if not applicable:
        return {'status': 'no_applicable_weight', 'value': None}
    result = 100 * earned / applicable
    cents = (result.numerator * 200 + result.denominator) // (result.denominator * 2)
    return {'status': 'available', 'value': cents / 100}


def compatibility_issues(record, checklist):
    issues = []
    expected = {'checklist_id': checklist.get('checklist_id'), 'version': checklist.get('version')}
    if record.get('checklist_binding') and record['checklist_binding'] != expected:
        issues.append('checklist_version_mismatch')
    if record.get('checklist_fingerprint') and record['checklist_fingerprint'] != canonical_hash(checklist):
        issues.append('checklist_snapshot_mismatch')
    return issues


def positive_metrics(matrix, positive):
    tp = matrix.get(positive, {}).get(positive, 0)
    fp = sum(row.get(positive, 0) for ref, row in matrix.items() if ref != positive)
    ref_positive = sum(matrix.get(positive, {}).values())
    fn = ref_positive - tp  # Missing/failed predictions are also missed positives.
    precision, recall = ratio(tp, tp + fp), ratio(tp, ref_positive)
    f1 = ratio(2 * tp, 2 * tp + fp + fn)
    return {'positive_label': positive, 'tp': tp, 'fp': fp, 'fn_including_unavailable': fn,
            'precision': precision, 'recall': recall, 'f1': f1}


def compare(predictions, references, checklist, view='original', derive_prediction_total=False):
    for rows in (predictions, references):
        if len({r['conversation_id'] for r in rows}) != len(rows):
            raise FormatError('Duplicate conversation_id: compare one run and one reference per dialog.')
    spec = {c['id']: c for c in checklist['criteria']}
    pred_by_id = {r['conversation_id']: r for r in predictions}
    if any(r.get('source_view') != VIEWS[view] for r in predictions):
        raise FormatError('Mixed source_view values are forbidden.')
    counters = {cid: {'matched': 0, 'reference_labeled': 0, 'reference_unlabeled': 0, 'reference_pending': 0,
                      'reference_invalid': 0, 'reference_incompatible': 0,
                      'prediction_valid': 0, 'prediction_missing': 0, 'prediction_unresolved': 0, 'prediction_invalid': 0,
                      'prediction_failed': 0, 'prediction_incompatible': 0,
                      'matrix': {}, 'numeric_errors': [], 'numeric_reference': 0,
                      'na_matrix': {'na': {'na': 0, 'applicable': 0, 'unavailable': 0},
                                    'applicable': {'na': 0, 'applicable': 0, 'unavailable': 0}}} for cid in spec}
    dialogs, total_errors, total_counts = [], [], Counter()
    full_vectors, matching_vectors, eligible_references = 0, 0, 0
    for reference in references:
        cid = reference['conversation_id']
        prediction = pred_by_id.get(cid)
        ref_map = {c['criterion_id']: c for c in reference['criteria']}
        pred_map = {c['criterion_id']: c for c in prediction['criteria']} if prediction else {}
        ref_issues = compatibility_issues(reference, checklist)
        pred_issues = compatibility_issues(prediction, checklist) if prediction else []
        unknown_ref_ids = sorted(set(ref_map) - set(spec))
        unknown_pred_ids = sorted(set(pred_map) - set(spec))
        if unknown_ref_ids:
            ref_issues.append('unknown_reference_criterion_ids')
        if unknown_pred_ids:
            pred_issues.append('unknown_prediction_criterion_ids')
        if prediction and reference.get('transcript_hash') and prediction.get('transcript_hash') and reference['transcript_hash'] != prediction['transcript_hash']:
            pred_issues.append('transcript_hash_mismatch')
        ref_ready = reference.get('annotation_status') in READY_REFERENCE
        ref_values, pred_values, criterion_errors, ref_skip = {}, {}, [], {}
        for criterion_id, criterion in spec.items():
            stat = counters[criterion_id]
            row = ref_map.get(criterion_id, {})
            value = row.get('value')
            if value is None or not ref_ready:
                stat['reference_unlabeled'] += 1
                ref_skip[criterion_id] = 'unannotated_or_null'
                continue
            if ref_issues:
                stat['reference_incompatible'] += 1
                ref_skip[criterion_id] = 'incompatible_reference_checklist'
                continue
            if row.get('needs_adjudication') is True:
                stat['reference_pending'] += 1
                ref_skip[criterion_id] = 'pending_adjudication'
                continue
            if not valid_value(value, criterion):
                stat['reference_invalid'] += 1
                ref_skip[criterion_id] = 'invalid_reference_value'
                continue
            ref_values[criterion_id] = value
            stat['reference_labeled'] += 1
            if prediction is None:
                state = 'missing'
            elif pred_issues:
                state = 'incompatible'
            elif prediction.get('record_status') not in {'completed', 'partial'}:
                state = 'failed'
            else:
                state = criterion_state(pred_map.get(criterion_id, {}), criterion)
            predicted = pred_map.get(criterion_id, {}).get('value') if state == 'valid' else UNAVAILABLE[state]
            stat['prediction_' + state] += 1
            if state == 'valid':
                pred_values[criterion_id] = predicted
            matrix_row = stat['matrix'].setdefault(label(value), {})
            matrix_row[label(predicted)] = matrix_row.get(label(predicted), 0) + 1
            same = state == 'valid' and value == predicted and (type(value) is type(predicted) or numeric(value) and numeric(predicted))
            if same:
                stat['matched'] += 1
            else:
                criterion_errors.append({'criterion_id': criterion_id, 'reference': value,
                                         'prediction': predicted, 'prediction_state': state})
            if 'na' in criterion['allowed_values']:
                truth_na = 'na' if value == 'na' else 'applicable'
                predicted_na = ('na' if predicted == 'na' else 'applicable') if state == 'valid' else 'unavailable'
                stat['na_matrix'][truth_na][predicted_na] += 1
            if criterion['type'] == 'scale' and numeric(value):
                stat['numeric_reference'] += 1
                if state == 'valid' and numeric(predicted):
                    stat['numeric_errors'].append(predicted - value)

        if ref_values:
            eligible_references += 1
        if len(ref_values) == len(spec):
            full_vectors += 1
            matching_vectors += int(not criterion_errors)

        # For arithmetic diagnostics, independently read every valid AI label,
        # including criteria whose expert labels are absent. No label is inferred.
        all_pred_values = {key: row.get('value') for key, row in pred_map.items()
                           if key in spec and criterion_state(row, spec[key]) == 'valid'} if prediction and not pred_issues and prediction.get('record_status') in {'completed', 'partial'} else {}
        unresolved_weighted = [key for key, row in pred_map.items() if key in spec and
                               spec[key]['type'] != 'flag' and spec[key]['weight'] > 0 and
                               criterion_state(row, spec[key]) == 'unresolved']
        ref_total = calculate_total(ref_values, checklist)
        pred_calculated = calculate_total(all_pred_values, checklist)
        declared_ref = reference.get('total_score')
        ref_total_source = 'derived_from_complete_weighted_reference_labels'
        if ref_total['status'] == 'available' and declared_ref is not None:
            if not numeric(declared_ref) or declared_ref != ref_total['value']:
                ref_total = {'status': 'inconsistent_declared_reference_total', 'value': None}
            else:
                ref_total_source = 'declared_and_checked_against_reference_labels'
        elif ref_total['status'] == 'no_applicable_weight' and declared_ref is not None:
            ref_total = {'status': 'inconsistent_declared_reference_total', 'value': None}

        reported_pred_total = prediction.get('total_score') if prediction else None
        pred_total_source = 'reported_selected_view'
        pred_total = reported_pred_total
        if prediction is None:
            pred_total_status = 'missing_prediction'
        elif pred_issues:
            pred_total_status = 'incompatible_prediction'
        elif prediction.get('record_status') not in {'completed', 'partial'}:
            pred_total_status = 'failed_prediction'
        elif unresolved_weighted:
            pred_total_status = 'unresolved_weighted_labels' if pred_total is None else 'incomplete_prediction_labels'
        elif pred_calculated['status'] == 'no_applicable_weight':
            pred_total_status = 'no_applicable_weight' if pred_total is None else 'invalid_total_for_no_applicable_weight'
        elif pred_total is None and derive_prediction_total and pred_calculated['status'] == 'available':
            pred_total, pred_total_status = pred_calculated['value'], 'available'
            pred_total_source = 'explicitly_derived_from_prediction_labels'
        elif numeric(pred_total) and 0 <= pred_total <= 100:
            pred_total_status = 'available'
        elif pred_total is None:
            pred_total_status = 'missing_total'
        else:
            pred_total_status = 'invalid_total'

        # An incomplete criterion vector must not pass as a complete scored AI result.
        if pred_total_status == 'available' and pred_calculated['status'] == 'missing_weighted_labels':
            pred_total_status = 'incomplete_prediction_labels'
        arithmetic_error = None
        if numeric(reported_pred_total) and pred_calculated['status'] == 'available':
            arithmetic_error = reported_pred_total - pred_calculated['value']
        total_counts['reference_' + ref_total['status']] += 1
        total_counts['prediction_' + pred_total_status] += 1
        total_error = None
        if ref_total['status'] == 'available':
            if pred_total_status == 'available':
                total_error = pred_total - ref_total['value']
                total_errors.append(total_error)
            else:
                total_counts['reference_numeric_but_prediction_unavailable'] += 1
        if ref_total['status'] == 'no_applicable_weight':
            total_counts['null_total_availability_matches' if pred_total_status == 'no_applicable_weight' else 'null_total_availability_errors'] += 1
        if arithmetic_error not in (None, 0):
            total_counts['prediction_arithmetic_mismatch'] += 1
        warnings = []
        for name, record in [('reference', reference), ('prediction', prediction)]:
            if record and not record.get('checklist_binding'):
                warnings.append(name + '_checklist_binding_missing')
            if record and not record.get('transcript_hash'):
                warnings.append(name + '_transcript_hash_missing')
        if unknown_ref_ids:
            warnings.append('unknown_reference_criterion_ids')
        if unknown_pred_ids:
            warnings.append('unknown_prediction_criterion_ids')
        dialogs.append({'conversation_id': cid, 'reference_usable_criteria': len(ref_values),
                        'prediction_record_status': prediction.get('record_status') if prediction else None,
                        'prediction_unresolved_weighted_ids': unresolved_weighted,
                        'reference_skipped_criteria': ref_skip, 'criterion_errors': criterion_errors,
                        'reference_compatibility_issues': ref_issues, 'prediction_compatibility_issues': pred_issues,
                        'unknown_reference_criterion_ids': unknown_ref_ids, 'unknown_prediction_criterion_ids': unknown_pred_ids,
                        'reference_total': ref_total, 'reference_total_source': ref_total_source,
                        'prediction_total': pred_total if pred_total_status == 'available' else None,
                        'prediction_total_status': pred_total_status, 'prediction_total_source': pred_total_source,
                        'reported_prediction_total': reported_pred_total if numeric(reported_pred_total) else None,
                        'recalculated_prediction_total': pred_calculated,
                        'prediction_arithmetic_error': arithmetic_error, 'total_error_prediction_minus_reference': total_error,
                        'warnings': warnings})

    criteria_metrics = {}
    for cid, criterion in spec.items():
        stat = counters[cid]
        result = {key: value for key, value in stat.items() if key not in {'matrix', 'numeric_errors', 'na_matrix', 'numeric_reference'}}
        result.update({'accuracy': ratio(stat['matched'], stat['reference_labeled']),
                       'confusion_matrix': {'rows': 'reference', 'columns': 'prediction; unavailable states are explicit',
                                            'counts': stat['matrix']}, 'allowed_values': criterion['allowed_values']})
        if criterion['type'] in {'boolean', 'flag'}:
            result['yes_metrics'] = positive_metrics(stat['matrix'], 'yes')
        if 'na' in criterion['allowed_values']:
            matrix = stat['na_matrix']
            tp, fp = matrix['na']['na'], matrix['applicable']['na']
            ref_na = sum(matrix['na'].values())
            fn = ref_na - tp
            result['na_selection'] = {
                'reference_na': ref_na, 'tp': tp, 'fp': fp, 'fn_including_unavailable': fn,
                'precision': ratio(tp, tp + fp), 'recall': ratio(tp, ref_na), 'f1': ratio(2 * tp, 2 * tp + fp + fn),
                'wrong_applicability_valid_predictions': matrix['na']['applicable'] + matrix['applicable']['na'],
                'prediction_unavailable': matrix['na']['unavailable'] + matrix['applicable']['unavailable'],
                'applicability_accuracy_including_unavailable': ratio(tp + matrix['applicable']['applicable'], stat['reference_labeled']),
                'confusion_matrix': matrix}
        if criterion['type'] == 'scale':
            result['numeric_scale'] = {**error_metrics(stat['numeric_errors']), 'reference_numeric_count': stat['numeric_reference'],
                                       'excluded_numeric_references_due_to_na_or_unavailable_prediction': stat['numeric_reference'] - len(stat['numeric_errors']),
                                       'scope': 'Only pairs with valid numeric values on both sides; N/A errors remain in exact and applicability metrics.'}
        criteria_metrics[cid] = result
    accuracies = [r['accuracy'] for r in criteria_metrics.values() if r['accuracy'] is not None]
    error_dialogs = [d for d in dialogs if d['criterion_errors'] or d['reference_compatibility_issues'] or d['prediction_compatibility_issues'] or
                     any(value == 'invalid_reference_value' for value in d['reference_skipped_criteria'].values()) or
                     d['reference_total']['status'] == 'inconsistent_declared_reference_total' or
                     d['total_error_prediction_minus_reference'] not in (None, 0) or d['prediction_arithmetic_error'] not in (None, 0) or
                     (d['reference_total']['status'] == 'no_applicable_weight' and d['prediction_total_status'] != 'no_applicable_weight') or
                     (d['reference_total']['status'] == 'available' and d['prediction_total_status'] != 'available')]
    status = 'no_reference_annotations' if not eligible_references else ('no_prediction_data' if not predictions else 'compared')
    return {
        'report_version': 'cqa-diagnostics-1', 'status': status,
        'notice': 'Internal diagnostic metrics, not the official jury formula. Human references are not automatically official Ground Truth.',
        'prediction_view': VIEWS[view], 'checklist_binding': {'checklist_id': checklist.get('checklist_id'), 'version': checklist.get('version')},
        'checklist_fingerprint': canonical_hash(checklist),
        'coverage': {'reference_records': len(references), 'prediction_records': len(predictions),
                     'references_with_usable_labels': eligible_references,
                     'reference_annotation_statuses': dict(Counter(str(r.get('annotation_status')) for r in references)),
                     'reference_kinds': dict(Counter(str(r.get('reference_kind')) for r in references)),
                     'prediction_record_statuses': dict(Counter(str(r.get('record_status')) for r in predictions)),
                     'prediction_ids_without_reference': sorted(set(pred_by_id) - {r['conversation_id'] for r in references}),
                     'reference_ids_without_prediction': sorted({r['conversation_id'] for r in references} - set(pred_by_id))},
        'criteria': criteria_metrics,
        'gross_error_flags': {cid: criteria_metrics[cid] for cid, c in spec.items() if c['type'] == 'flag'},
        'summary': {'macro_criterion_accuracy': sum(accuracies) / len(accuracies) if accuracies else None,
                    'macro_criteria_denominator': len(accuracies), 'fully_labeled_dialogs': full_vectors,
                    'exact_matching_full_vectors': matching_vectors, 'full_vector_accuracy': ratio(matching_vectors, full_vectors)},
        'totals': {**error_metrics(total_errors), 'counts': dict(total_counts),
                   'exact_matches': sum(e == 0 for e in total_errors), 'exact_match_rate': ratio(sum(e == 0 for e in total_errors), len(total_errors)),
                   'within_1_rate': ratio(sum(abs(e) <= 1 for e in total_errors), len(total_errors)),
                   'within_5_rate': ratio(sum(abs(e) <= 5 for e in total_errors), len(total_errors)),
                   'tolerances_are_internal_diagnostics': True},
        'per_dialog': dialogs, 'errors_by_dialog': error_dialogs,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    convert = sub.add_parser('convert', help='Explicitly convert one JSON/JSONL batch to the internal format.')
    convert.add_argument('--input', required=True)
    convert.add_argument('--output', required=True)
    convert.add_argument('--kind', choices=['prediction', 'reference'], required=True)
    convert.add_argument('--format', choices=['evaluation', 'expert', 'internal'], required=True)
    convert.add_argument('--view', choices=VIEWS, default='original')
    run = sub.add_parser('compare', help='Compare one AI run with one expert/adjudicated reference file.')
    run.add_argument('--predictions')
    run.add_argument('--prediction-format', choices=['evaluation', 'internal'], default='evaluation')
    run.add_argument('--references', required=True)
    run.add_argument('--reference-format', choices=['expert', 'internal'], default='expert')
    run.add_argument('--checklist', default=str(ROOT / 'config' / 'checklist.v1.json'))
    run.add_argument('--view', choices=VIEWS, default='original')
    run.add_argument('--derive-prediction-total', action='store_true', help='Explicitly derive missing AI totals from complete weighted labels; off by default.')
    run.add_argument('--output', required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'convert':
            rows = normalize_records(load_records(args.input), args.kind, args.format, args.view)
            write_json(args.output, rows, jsonl=Path(args.output).suffix.lower() == '.jsonl')
            print(json.dumps({'status': 'converted', 'records': len(rows), 'format_version': FORMAT}))
        else:
            checklist = read_checklist(args.checklist)
            references = normalize_records(load_records(args.references), 'reference', args.reference_format, args.view)
            predictions = normalize_records(load_records(args.predictions), 'prediction', args.prediction_format, args.view) if args.predictions else []
            report = compare(predictions, references, checklist, args.view, args.derive_prediction_total)
            write_json(args.output, report)
            print(json.dumps({'status': report['status'], 'prediction_view': report['prediction_view'],
                              'references_with_usable_labels': report['coverage']['references_with_usable_labels'],
                              'paired_totals': report['totals']['count'], 'output': str(Path(args.output))}, ensure_ascii=False))
        return 0
    except (FormatError, OSError, KeyError, TypeError, ValueError) as exc:
        # Deliberately avoid echoing source records, quotes or signed audio URLs.
        message = str(exc) if isinstance(exc, FormatError) else type(exc).__name__
        print(json.dumps({'status': 'input_error', 'error': message}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
