"""Print a bounded private review segment; no signed audio URLs."""
import json, sys
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
root = Path(__file__).resolve().parents[2]
report=json.loads((root/'data/external-review/comparison.json').read_text(encoding='utf-8'))
dialogs={r['conversation_id']:r for r in map(json.loads,(root/'data/dev/indexed-transcripts.jsonl').read_text(encoding='utf-8').splitlines())}
criterion=sys.argv[1]
start=int(sys.argv[2]) if len(sys.argv)>2 else 0
limit=int(sys.argv[3]) if len(sys.argv)>3 else 20
mode=sys.argv[4] if len(sys.argv)>4 else 'operator'
cases=[r for r in report['disagreements'] if r['criterion_id']==criterion]
print('criterion',criterion,'cases',len(cases),'slice',start,start+limit)
for r in cases[start:start+limit]:
    print('\n'+r['conversation_id'],json.dumps(r['values'],ensure_ascii=False))
    for s,e in r['sources'].items():
        reason=e.get('explanation') or e.get('note')
        if reason and (s in ('azimxxd','Iza-git') or (len(sys.argv)>5 and sys.argv[5]=='all')): print(s,reason)
    ms=dialogs[r['conversation_id']]['messages']
    if mode=='none': ms=[]
    elif ':' in mode:
        lo,hi=map(int,mode.split(':'));ms=ms[lo-1:hi]
    elif mode=='end': ms=ms[-5:]
    elif mode=='first': ms=ms[:1]+[m for m in ms if m['speaker']=='operator'][:2]
    elif mode=='operator': ms=[m for m in ms if m['speaker'] in ('operator','client')]
    for m in ms: print(m['message_id'],m['speaker'],m['text'])
