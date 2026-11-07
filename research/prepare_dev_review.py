"""Audit DEV and freeze metadata-only splits before inspecting transcript content."""
from collections import Counter, defaultdict
from datetime import datetime
from hashlib import sha256
from pathlib import Path
import json
import re
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
RESEARCH = ROOT / 'research'
DATA = ROOT / 'data' / 'dev'
SEED = 'cqa-dev-split-v1|2026-11-07'
QUOTAS = {
    ('RU', 'agent chat'): (8, 4),
    ('RU', 'voice call'): (2, 1),
    ('KZ', 'agent chat'): (5, 3),
    ('EN', 'agent chat'): (5, 2),
}


def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def lines(path, rows):
    path.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows), encoding='utf-8')


def digest(value):
    return sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode('utf-8')).hexdigest()


def timestamp_seconds(value, channel):
    if channel == 'agent chat':
        if not isinstance(value, str) or not re.fullmatch(r'\d{2,}:\d{2}', value):
            raise ValueError('chat_timestamp_not_MM_SS')
        minute, second = map(int, value.split(':'))
        if second >= 60:
            raise ValueError('invalid_seconds')
        return minute * 60 + second
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('voice_timestamp_without_timezone')
    return dt.timestamp()


def main():
    source = DATA / 'api-response.json'
    payload = json.loads(source.read_bytes())
    records = payload['data']['records']
    dataset_hash = sha256(source.read_bytes()).hexdigest()
    groups = defaultdict(list)
    errors = []
    warnings = []
    message_counts = Counter()
    roles = Counter()
    message_keys = Counter()
    record_keys = Counter()
    exact_text_groups = defaultdict(list)
    audio_inventory = []
    indexed = []
    for record in records:
        cid = record.get('conversation_id')
        channel = record.get('channel')
        groups[(record.get('language'), channel)].append(cid)
        record_keys.update(record.keys())
        transcript = record.get('transcript')
        if not isinstance(transcript, list) or not transcript:
            errors.append({'conversation_id': cid, 'issue': 'missing_or_empty_transcript'})
            continue
        times = []
        messages = []
        for i, message in enumerate(transcript, 1):
            mid = f'm{i:04d}'
            roles[message.get('speaker')] += 1
            message_keys.update(message.keys())
            if message.get('speaker') not in {'client', 'operator', 'bot', 'system'}:
                errors.append({'conversation_id': cid, 'message_id': mid, 'issue': 'unexpected_role'})
            if not isinstance(message.get('text'), str) or not message['text'].strip():
                errors.append({'conversation_id': cid, 'message_id': mid, 'issue': 'missing_or_empty_text'})
            try:
                times.append(timestamp_seconds(message.get('timestamp'), channel))
            except (ValueError, TypeError, AttributeError):
                errors.append({'conversation_id': cid, 'message_id': mid, 'issue': 'invalid_timestamp'})
            messages.append({'message_id': mid, 'source_index_zero_based': i - 1, **message})
        if any(b < a for a, b in zip(times, times[1:])):
            warnings.append({'conversation_id': cid, 'issue': 'timestamp_order_not_monotonic'})
        message_counts[cid] = len(transcript)
        exact_text_groups[digest([{'speaker': m.get('speaker'), 'text': m.get('text')} for m in transcript])].append(cid)
        audio = record.get('audio_url')
        audio_info = {'conversation_id': cid, 'present': bool(audio)}
        if audio:
            parsed = urlsplit(audio)
            audio_info.update({'scheme': parsed.scheme, 'host': parsed.hostname,
                               'query_parameter_names': sorted(parse_qs(parsed.query)),
                               'is_absolute_http_url': parsed.scheme in {'https', 'http'} and bool(parsed.netloc),
                               'access_checked': False})
        if bool(audio) != (channel == 'voice call'):
            warnings.append({'conversation_id': cid, 'issue': 'audio_presence_channel_mismatch'})
        audio_inventory.append(audio_info)
        indexed.append({'conversation_id': cid, 'channel': channel, 'language': record.get('language'),
                        'transcript_hash': digest(transcript), 'messages': messages, 'audio_url': audio})

    ids = [r.get('conversation_id') for r in records]
    duplicate_ids = [key for key, count in Counter(ids).items() if count > 1]
    if duplicate_ids:
        errors.append({'issue': 'duplicate_conversation_ids', 'ids': duplicate_ids})
    if payload.get('isSuccess') is not True or payload['data'].get('total_records') != len(records):
        errors.append({'issue': 'API_success_or_total_records_mismatch'})
    expected_keys = {'conversation_id', 'channel', 'language', 'transcript', 'audio_url'}
    unexpected_record_keys = sorted(set(record_keys) - expected_keys)
    profile = {
        'source_sha256': dataset_hash,
        'isSuccess': payload.get('isSuccess'), 'dataset_group_id': payload['data'].get('dataset_group_id'),
        'declared_records': payload['data'].get('total_records'), 'actual_records': len(records),
        'unique_conversation_ids': len(set(ids)), 'duplicate_ids': duplicate_ids,
        'languages': dict(Counter(r.get('language') for r in records)),
        'channels': dict(Counter(r.get('channel') for r in records)),
        'strata': [{'language': key[0], 'channel': key[1], 'count': len(value)} for key, value in sorted(groups.items())],
        'message_count': sum(message_counts.values()), 'roles': dict(roles),
        'record_keys': dict(record_keys), 'message_keys': dict(message_keys),
        'unexpected_record_keys': unexpected_record_keys,
        'structured_ground_truth_present': False,
        'ground_truth_check_basis': 'Only documented data/records/transcript fields exist; no scores, labels or annotation fields in this response. No claim about other endpoints.',
        'audio_inventory': audio_inventory,
        'exact_duplicate_transcript_groups_ignoring_timestamps': [v for v in exact_text_groups.values() if len(v) > 1],
        'errors': errors, 'warnings': warnings,
    }
    dump(RESEARCH / 'dev-profile.json', profile)
    lines(DATA / 'indexed-transcripts.jsonl', indexed)
    if errors:
        raise SystemExit('Audit errors: inspect research/dev-profile.json before freezing a split.')

    split = {'method': 'metadata-stratified SHA256 ascending rank; pilot first, holdout next, rest remainder',
             'seed': SEED, 'ranking_expression': 'SHA256(UTF8(seed + "|" + conversation_id))',
             'source_sha256': dataset_hash, 'used_for_selection': ['conversation_id', 'language', 'channel'],
             'not_used_for_selection': ['transcript_content', 'AI_outputs', 'scores', 'expert_labels'],
             'pilot20': [], 'holdout10': [], 'remainder35': [], 'strata': []}
    for key, group_ids in sorted(groups.items()):
        ordered = sorted(group_ids, key=lambda cid: (sha256((SEED + '|' + cid).encode('utf-8')).hexdigest(), cid))
        pilot_n, holdout_n = QUOTAS[key]
        if len(ordered) < pilot_n + holdout_n:
            raise SystemExit('Insufficient stratum size; no adaptive fallback is implemented.')
        pilot = ordered[:pilot_n]
        holdout = ordered[pilot_n:pilot_n + holdout_n]
        remainder = ordered[pilot_n + holdout_n:]
        split['pilot20'].extend(pilot)
        split['holdout10'].extend(holdout)
        split['remainder35'].extend(remainder)
        split['strata'].append({'language': key[0], 'channel': key[1], 'available': len(group_ids),
                                'pilot': pilot_n, 'holdout': holdout_n, 'remainder': len(remainder)})
    all_split_ids = split['pilot20'] + split['holdout10'] + split['remainder35']
    if len(split['pilot20']) != 20 or len(split['holdout10']) != 10 or len(set(all_split_ids)) != len(records) or set(all_split_ids) != set(ids):
        raise SystemExit('Split invariant failure')
    split_path = RESEARCH / 'dev-split-v1.json'
    if split_path.exists() and json.loads(split_path.read_text(encoding='utf-8')) != split:
        raise SystemExit('Existing frozen split differs: create an explicitly versioned replacement instead.')
    dump(split_path, split)
    by_id = {r['conversation_id']: r for r in indexed}
    checklist = [{'id': '01', 'allowed_values': ['yes', 'no']},
                 {'id': '02', 'allowed_values': ['yes', 'no', 'na']},
                 {'id': '03', 'allowed_values': ['yes', 'no', 'na']},
                 {'id': '04', 'allowed_values': [0, 5, 10, 15, 20, 'na']},
                 {'id': '05', 'allowed_values': ['yes', 'no']},
                 {'id': '06', 'allowed_values': [0, 4, 7, 10]},
                 {'id': '07', 'allowed_values': ['yes', 'no', 'na']},
                 {'id': '08', 'allowed_values': ['yes', 'no']}]
    for split_key, annotator in [('pilot20', 'a'), ('pilot20', 'b'), ('holdout10', 'a'), ('holdout10', 'b')]:
        target = RESEARCH / f'{split_key}-expert-{annotator}.blank.jsonl'
        # Never overwrite work after an expert has started filling in a template.
        if target.exists():
            continue
        blank = []
        for cid in split[split_key]:
            blank.append({'conversation_id': cid, 'transcript_hash': by_id[cid]['transcript_hash'],
                          'reference_kind': 'unannotated_template_not_ground_truth',
                          'annotation_status': 'unannotated', 'annotator_id': None, 'annotated_at': None,
                          'checklist_version': 'initial-pdf-v1',
                          'criteria': [{'criterion_id': c['id'], 'allowed_values': c['allowed_values'],
                                        'value': None, 'explanation': None, 'evidence': [], 'checked_ranges': [],
                                        'na_reason': None, 'uncertainties': [], 'needs_adjudication': None} for c in checklist],
                          'overall_notes': None, 'total_score': None})
        lines(target, blank)
    source_method = ROOT / 'output' / 'cqa-methodology.txt'
    if source_method.exists():
        preface = ('Примечание после загрузки DEV: ниже сохранён полный первоначальный методический отчёт. '
                   'Указания в нём о ещё не загруженных данных относятся к моменту его подготовки. '
                   'Актуальный результат загрузки, состав, отсутствие структурированного GT и ограничения: '
                   'research/dev-review-brief.txt и research/dev-profile.json. AI-эксперименты по-прежнему не запускались.\n\n')
        (RESEARCH / 'cqa-methodology.txt').write_text(preface + source_method.read_text(encoding='utf-8'), encoding='utf-8')
    print(json.dumps({'profile': 'research/dev-profile.json', 'split': 'research/dev-split-v1.json',
                      'errors': errors, 'warnings': warnings, 'pilot20': split['pilot20'], 'holdout10': split['holdout10']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
