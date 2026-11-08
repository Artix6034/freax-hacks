// Explicit final stages, sequential; no retries and no full DEV run.
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const baseline=JSON.parse(await readFile('data/hypotheses-2026-11-08/baseline-discovery/summary.json','utf8'));
const candidate=JSON.parse(await readFile('data/hypotheses-2026-11-08/candidate-discovery/summary.json','utf8'));
if(baseline.actual_calls!==47||candidate.actual_calls!==47)throw Error('Complete matched diagnostic stages first');
for(const [stage,split] of [['baseline','invariance'],['candidate','invariance'],['baseline','holdout'],['candidate','holdout'],['candidate','dev']]){
 const args=['--env-file=.env','research/hypotheses-2026-11-08/run.mjs','--live',`--stage=${stage}`,`--split=${split}`];
 if(stage==='candidate')args.push('--candidate=research/hypotheses-2026-11-08/candidate.json');
 const child=spawn(process.execPath,args,{stdio:'inherit',windowsHide:true});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 if(code!==0)throw Error(`Stage ${stage}/${split} stopped, exit ${code}; no retry performed`);
}
