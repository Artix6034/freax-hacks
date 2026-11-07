import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const git=args=>spawnSync('git',args,{encoding:'utf8',windowsHide:true});
const expected=[['.env',true],['.env.local',true],['.env.example',false],['data/dev/api-response.json',true],
 ['tmp/pdfs/checklist-2.png',true],['reference/baseline/cqa-baseline/README.md',true],['output/audit/cqa-reliability-2026-11-07.txt',true],
 ['results/dev/results.json',false],['results/prod/.gitkeep',false],['src/web/app.js',false],['docs/architecture-and-teamwork.txt',false]];
const checks=[];
for(const [path,ignored] of expected){const r=git(['check-ignore','--no-index','--quiet','--',path]);assert.ok([0,1].includes(r.status));assert.equal(r.status===0,ignored,path);checks.push({path,ignored});}
const listed=git(['ls-files','--cached','--others','--exclude-standard','-z']);assert.equal(listed.status,0);
const files=[...new Set(listed.stdout.split('\0').filter(Boolean))];let totalBytes=0,syntheticCredentialFixtures=0;const flagged=[];
for(const path of files){
 assert.ok(!/^(?:data|tmp|output|reference|\.playwright-cli)\//.test(path),path);assert.ok(!/^\.env(?:\..*)?$/.test(path)||path==='.env.example');
 const buffer=await readFile(path);totalBytes+=buffer.length;const content=buffer.toString('utf8');
 for(const m of content.matchAll(/\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/g)){
  if(path==='tests/submission.test.js'&&m[0]===['sk','proj','TEST_ONLY_NOT_A_REAL_KEY_0123456789'].join('-'))syntheticCredentialFixtures++;else flagged.push(path);
 }
 for(const m of content.matchAll(/[?&](?:sig|signature|token)=([A-Za-z0-9_%.-]{16,})/g))if(!/^(?:TEST|EXAMPLE|DUMMY)/.test(m[1]))flagged.push(path);
}
assert.deepEqual([...new Set(flagged)],[],'Credential-looking literal detected; inspect the filename locally without logging the value.');
const report={notice:'Repository preparation checks for excluded local data and credential-looking literals; no remote publish.',branch:git(['branch','--show-current']).stdout.trim(),candidate_files:files.length,total_bytes:totalBytes,ignore_checks:checks,credential_literal_matches:0,synthetic_credential_fixtures:syntheticCredentialFixtures};
await mkdir('data/reliability',{recursive:true});await writeFile('data/reliability/repository-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
