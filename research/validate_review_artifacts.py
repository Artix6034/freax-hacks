"""Validate split isolation, actual message references, empty expert forms and URL redaction."""
from collections import Counter
from hashlib import sha256
from pathlib import Path
import json
from urllib.parse import parse_qs, urlsplit

from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
R = ROOT / 'research'
D = ROOT / 'data' / 'dev'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def main():
    raw = (D / 'api-response.json').read_bytes()
    records = json.loads(raw)['data']['records']
    split = read(R / 'dev-split-v1.json')
    checks = {}
    checks['source_hash_matches_frozen_split'] = sha256(raw).hexdigest() == split['source_sha256']
    checks['expected_counts'] = [len(split[k]) for k in ('pilot20', 'holdout10', 'remainder35')] == [20, 10, 35]
    merged = split['pilot20'] + split['holdout10'] + split['remainder35']
    checks['disjoint_and_complete'] = len(merged) == len(set(merged)) == len(records) and set(merged) == {r['conversation_id'] for r in records}
    indexed = [json.loads(line) for line in (D / 'indexed-transcripts.jsonl').read_text(encoding='utf-8').splitlines()]
    by_id = {r['conversation_id']: r for r in indexed}
    checks['indexed_messages_preserve_source'] = all(
        len(r['transcript']) == len(by_id[r['conversation_id']]['messages']) and all(
            m['message_id'] == f'm{i + 1:04d}' and m['source_index_zero_based'] == i and
            {k: m[k] for k in ('timestamp', 'speaker', 'text')} == original
            for i, (m, original) in enumerate(zip(by_id[r['conversation_id']]['messages'], r['transcript']))
        ) for r in records
    )
    cases = read(R / 'real-case-catalogue.json')['cases']
    checks['catalogue_only_uses_pilot'] = all(c['conversation_id'] in split['pilot20'] for c in cases)
    checks['all_catalogue_message_ids_exist'] = all(
        set(c['message_ids']) <= {m['message_id'] for m in by_id[c['conversation_id']]['messages']} for c in cases
    )
    checks['catalogue_case_ids_unique'] = len({c['case_id'] for c in cases}) == len(cases)
    checks['catalogue_has_no_scores'] = all('value' not in c and 'score' not in c for c in cases)
    template_count = 0
    for file in sorted(R.glob('*-expert-*.blank.jsonl')):
        forms = [json.loads(line) for line in file.read_text(encoding='utf-8').splitlines()]
        key = file.name.split('-expert-')[0]
        checks[file.name + ':ids'] = [f['conversation_id'] for f in forms] == split[key]
        checks[file.name + ':empty_values'] = all(f['annotation_status'] == 'unannotated' and f['total_score'] is None and
            len(f['criteria']) == 8 and all(c['value'] is None and c['explanation'] is None and not c['evidence'] and not c['checked_ranges'] and
                c['na_reason'] is None and not c['uncertainties'] and c['needs_adjudication'] is None for c in f['criteria']) for f in forms)
        checks[file.name + ':hashes'] = all(f['transcript_hash'] == by_id[f['conversation_id']]['transcript_hash'] for f in forms)
        template_count += len(forms)
    # Verify source GET signatures and raw audio URLs have not leaked into research files.
    secret_fragments = set()
    pdf = Path(r'C:/Users/user/Downloads/Telegram Desktop/CQA_Hackathon_Student_Guide_v3 1.pdf')
    for annotation in PdfReader(pdf).pages[2].get('/Annots', []):
        action = annotation.get_object().get('/A')
        uri = action.get_object().get('/URI') if action else None
        if uri:
            secret_fragments.update(parse_qs(urlsplit(str(uri)).query).get('sig', []))
            secret_fragments.add(str(uri))
    for rec in records:
        if rec.get('audio_url'):
            secret_fragments.add(rec['audio_url'])
            secret_fragments.update(parse_qs(urlsplit(rec['audio_url']).query).get('sig', []))
    leaks = []
    for file in R.iterdir():
        if not file.is_file():
            continue
        content = file.read_text(encoding='utf-8')
        if any(secret and secret in content for secret in secret_fragments):
            leaks.append(file.name)
    checks['no_signed_urls_or_signatures_in_research'] = not leaks
    report = {'passed': all(checks.values()), 'checks': checks, 'catalogue_cases': len(cases),
              'template_rows': template_count, 'source_records': len(records),
              'source_messages': sum(len(r['transcript']) for r in records),
              'research_files_with_secret_leaks': leaks,
              'ground_truth_created': False, 'external_AI_calls': 0}
    (R / 'validation-summary.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
