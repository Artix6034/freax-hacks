"""Offline source-preserving comparison. Does not execute downloaded repository code."""
import csv
import hashlib
import itertools
import json
import subprocess
import zipfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/external-review'
OUT.mkdir(parents=True, exist_ok=True)
RUN_ID = '608e0e6b-72f4-4ea6-b34f-3c1bbaa04704'
read = lambda p: json.loads(Path(p).read_text(encoding='utf-8-sig'))
lines = lambda p: [json.loads(s) for s in Path(p).read_text(encoding='utf-8').splitlines() if s.strip()]
indexed = {c['conversation_id']: c for c in lines(ROOT / 'data/dev/indexed-transcripts.jsonl')}
assert len(indexed) == 65
codes = ['01_contact', '02_needs', '03_identification', '04_consultation', '05_empathy', '06_dialog', '07_closing', '08_gross']
allowed = {f'{n:02}': ({0, 5, 10, 15, 20, 'na'} if n == 4 else {0, 4, 7, 10} if n == 6 else {'yes', 'no', 'na'} if n in (1, 2, 3, 7) else {'yes', 'no'}) for n in range(1, 9)}
sources = {s: {} for s in ('runtime', 'data_chat', 'azimxxd', 'Iza-git')}
manifest = {'notice': 'External team annotations, not official GT. Human authorship/review unverified. No production labels or verdicts replaced.', 'runtime_run_id': RUN_ID, 'repositories': []}
for owner, repo in [('azimxxd', 'cqa-hackathon'), ('Iza-git', 'cqa-hackathon'), ('atomi7e', 'cqa-hackathon'), ('CurtisEllese', 'cqa-evidence')]:
    directory = ROOT / f'data/external-repos/{owner}-{repo}'
    sha = subprocess.check_output(['git', '-C', str(directory), 'rev-parse', 'HEAD'], text=True).strip()
    stamp = subprocess.check_output(['git', '-C', str(directory), 'show', '-s', '--format=%cI', 'HEAD'], text=True).strip()
    manifest['repositories'].append({'repository': f'{owner}/{repo}', 'url': f'https://github.com/{owner}/{repo}', 'commit': sha, 'commit_time': stamp, 'directory': str(directory), 'license_api': None, 'mode': 'static inspection only'})

def put(source, cid, criterion, value, **extra):
    if isinstance(value, str):
        value = {'да': 'yes', 'нет': 'no', 'n/a': 'na', '': None}.get(value.strip().lower(), value.strip().lower())
        if isinstance(value, str) and value.isdigit():
            value = int(value)
    assert cid in indexed, (source, cid)
    assert value is None or value in allowed[criterion], (source, cid, criterion, value)
    key = f'{cid}:{criterion}'
    assert key not in sources[source], key
    sources[source][key] = dict(conversation_id=cid, criterion_id=criterion, value=value, **extra)

run = read(ROOT / f'data/runs/{RUN_ID}.json')
records = {}
for task in run['tasks']:
    r = read(ROOT / f'data/{task["evaluation_id"]}.json')
    records[task['conversation_id']] = r
    assert [{k:m[k] for k in ('message_id','timestamp','speaker','text')} for m in r['conversation']['transcript']] == [{k:m[k] for k in ('message_id','timestamp','speaker','text')} for m in indexed[task['conversation_id']]['messages']]
    for c in r['ai_review']['criteria']:
        put('runtime', task['conversation_id'], c['criterion_id'], c['value'] if c['status']=='resolved' else None, explanation=c['explanation'], status=c['status'], evidence=c.get('evidence', []))
for r in lines(ROOT / 'data/annotations/dev65.ai-provisional.jsonl'):
    assert r['transcript_hash'] == indexed[r['conversation_id']]['transcript_hash']
    for c in r['criteria']:
        put('data_chat', r['conversation_id'], c['criterion_id'], None if c.get('needs_review') else c['value'], explanation=c['explanation'], evidence=c.get('evidence', []), provenance='ai_provisional')

azdir = ROOT / 'data/external-repos/azimxxd-cqa-hackathon/eval/labels'
for f in sorted(azdir.glob('*.json')):
    raw = read(f)
    assert len(raw) == 8
    for c in raw:
        put('azimxxd', f.stem, c['criterion_id'].removeprefix('c'), c['scale_value'] if c['scale_value'] is not None else c['answer'], note=c.get('note'), raw=c, provenance='repository claims hand labels; independently unverified')
iza_csv = ROOT / 'data/external-repos/Iza-git-cqa-hackathon/research/labels.csv'
iza_rows = list(csv.DictReader(iza_csv.open(encoding='utf-8-sig', newline='')))
manifest['label_files'] = [{'path': str(f.relative_to(ROOT)), 'sha256': hashlib.sha256(f.read_bytes()).hexdigest()} for f in sorted(azdir.glob('*.json'))] + [{'path': str(iza_csv.relative_to(ROOT)), 'sha256': hashlib.sha256(iza_csv.read_bytes()).hexdigest()}]
manifest['alignment_limit'] = 'Our runtime and data_chat match the local DEV transcript exactly. External labels have matching IDs and Iza references fit full-transcript one-based indices; external source transcript hashes are absent, so exact external dataset identity is not cryptographically established.'
evidence_checks = []
for r in iza_rows:
    if not any(r.get(code+'_answer','').strip() for code in codes):
        continue
    for i, code in enumerate(codes, 1):
        value = r[code+'_answer']
        refs = [int(x.strip()) for x in r[code+'_evidence'].split(',') if x.strip()]
        messages = indexed[r['conversation_id']]['messages']
        evidence_checks.append({'conversation_id': r['conversation_id'], 'criterion_id': f'{i:02}', 'refs': refs, 'valid_one_based_full_transcript_indices': all(1 <= n <= len(messages) for n in refs), 'evidence_texts': [messages[n-1] for n in refs if 1 <= n <= len(messages)]})
        put('Iza-git', r['conversation_id'], f'{i:02}', value, explanation=r[code+'_comment'], evidence_turns_one_based=refs, notes=r.get('notes'), provenance='repository claims hand labels; independently unverified')
assert len(sources['azimxxd']) == 520
assert len(sources['Iza-git']) == 112

pairs = []
for a,b in itertools.combinations(sources,2):
    common = sorted(sources[a].keys() & sources[b].keys())
    both = [k for k in common if sources[a][k]['value'] is not None and sources[b][k]['value'] is not None]
    matches = [k for k in both if sources[a][k]['value']==sources[b][k]['value']]
    by = {}
    for i in range(1,9):
        ks = [k for k in both if k.endswith(f':{i:02}')]
        by[f'{i:02}'] = {'both_known':len(ks), 'agree':sum(sources[a][k]['value']==sources[b][k]['value'] for k in ks)}
    pairs.append({'a':a,'b':b,'overlap_positions':len(common),'both_known':len(both),'agree':len(matches),'agreement':len(matches)/len(both) if both else None,'unknown_a':sum(sources[a][k]['value'] is None for k in common),'unknown_b':sum(sources[b][k]['value'] is None for k in common),'by_criterion':by})

disagreements = []
for cid in indexed:
    for i in range(1,9):
        criterion=f'{i:02}'; key=f'{cid}:{criterion}'
        entries={s:rows[key] for s,rows in sources.items() if key in rows}
        vals={s:e['value'] for s,e in entries.items()}
        if len(set(vals.values())) > 1:
            disagreements.append({'conversation_id':cid,'criterion_id':criterion,'values':vals,'sources':entries})

summary = {'notice':'Agreement between unverified references, not accuracy. No majority voting and no label replacement.', 'provenance':manifest, 'counts':{s:{'positions':len(v),'known':sum(x['value'] is not None for x in v.values()),'dialogues':len(set(x['conversation_id'] for x in v.values())),'with_explanation_or_note':sum(bool(x.get('explanation') or x.get('note')) for x in v.values())} for s,v in sources.items()}, 'iza_csv_rows':len(iza_rows),'iza_evidence_positions_with_refs':sum(bool(x['refs']) for x in evidence_checks),'iza_invalid_reference_positions':sum(not x['valid_one_based_full_transcript_indices'] for x in evidence_checks), 'pairs':pairs,'disagreement_positions':len(disagreements),'disagreements':disagreements}
(OUT/'comparison.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2),encoding='utf-8')
(OUT/'normalized-labels.json').write_text(json.dumps(sources, ensure_ascii=False, indent=2),encoding='utf-8')
(OUT/'iza-evidence.json').write_text(json.dumps(evidence_checks, ensure_ascii=False, indent=2),encoding='utf-8')
(OUT/'source-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2),encoding='utf-8')
with zipfile.ZipFile(OUT/'external-labels-reference.zip','w',zipfile.ZIP_DEFLATED) as z:
    for f in sorted(azdir.glob('*')):
        if f.is_file(): z.write(f,'azimxxd/eval/labels/'+f.name)
    z.write(iza_csv,'Iza-git/research/labels.csv')
    for name in ['research/edge_cases.md','research/compare.py','results/REPORT.md']:
        z.write(iza_csv.parents[1]/name,'Iza-git/'+name)
    z.write(OUT/'source-manifest.json','source-manifest.json')
    z.writestr('NOTICE.txt','Private comparison reference only. External repository claims are not official Ground Truth. Human authorship is unverified. No project license was detected by GitHub metadata. Preserve attribution; do not publish or import automatically.\n')
with zipfile.ZipFile(OUT/'external-labels-reference.zip') as z:
    assert z.testzip() is None
    assert len([n for n in z.namelist() if n.startswith('azimxxd/eval/labels/') and n.endswith('.json')]) == 65
    assert hashlib.sha256(z.read('Iza-git/research/labels.csv')).hexdigest() == hashlib.sha256(iza_csv.read_bytes()).hexdigest()
    for f in sorted(azdir.glob('*.json')):
        assert z.read('azimxxd/eval/labels/'+f.name) == f.read_bytes()
(OUT/'archive-sha256.txt').write_text(hashlib.sha256((OUT/'external-labels-reference.zip').read_bytes()).hexdigest()+'  external-labels-reference.zip\n',encoding='utf-8')
review = []
for cid in indexed:
    cases = [d for d in disagreements if d['conversation_id']==cid]
    if not cases: continue
    review.append('\n### '+cid)
    for d in cases:
        review.append(d['criterion_id']+' '+json.dumps(d['values'],ensure_ascii=False))
        for s,e in d['sources'].items():
            reason=e.get('explanation') or e.get('note')
            if reason: review.append('  '+s+': '+reason)
    for m in indexed[cid]['messages']:
        review.append(f'{m["message_id"]} {m["timestamp"]} {m["speaker"]}: {m["text"]}')
(OUT/'review-pack.txt').write_text('\n'.join(review),encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k not in ('disagreements','provenance')},ensure_ascii=False,indent=2))
