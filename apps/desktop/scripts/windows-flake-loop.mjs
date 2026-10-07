// Explicit repeated acceptance, never retries: every result contributes to failure.
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const suite=process.argv[2];
const count=Number(process.argv[3]);
const output=process.argv[4] && resolve(process.argv[4]);
if(process.platform!=='win32'||process.arch!=='x64'||!['spa','startup'].includes(suite)||!Number.isSafeInteger(count)||count<1||count>50||!output) {
  throw Error('Usage on Windows x64: node windows-flake-loop.mjs spa|startup 1..50 OUTPUT');
}
mkdirSync(output,{recursive:true});
const results=[];
const save=()=>writeFileSync(resolve(output,'summary.json'),JSON.stringify({schema:1,suite,iterations:count,completed:results.length,failures:results.filter(r=>!r.passed).length,results},null,2)+'\n');
if(suite==='spa') {
  const build=spawnSync('cargo',['build','--locked','-p','plur1bus-desktop','--example','production_spa','--example','production_driver'],{cwd:desktop,stdio:'inherit',timeout:900000});
  if(build.status!==0) {save();process.exit(build.status??1);}
}
for(let iteration=1;iteration<=count;iteration++) {
  const path=resolve(output,String(iteration));mkdirSync(path,{recursive:false});
  const started=performance.now();
  const timings=resolve(path,'startup-timings.json');
  const args=suite==='spa'?[path]:['--test',resolve(desktop,'scripts/windows-startup.test.mjs')];
  const executable=suite==='spa'?resolve(desktop,'target/debug/examples/production_driver.exe'):process.execPath;
  const child=spawnSync(executable,args,{cwd:desktop,stdio:'inherit',timeout:suite==='spa'?240000:120000,env:{...process.env,RUNNER_TEMP:path,PLUR1BUS_F2_STARTUP_TIMINGS:timings,PLUR1BUS_F2_STARTUP_ROOT:path,PLUR1BUS_F2_STARTUP_PRODUCTION_CAP:"1"}});
  let passed=child.status===0&&!child.error;
  if(suite==='startup'&&passed) {
    try {const evidence=JSON.parse(readFileSync(timings,'utf8'));passed=evidence.timings?.some(record=>record.phase==='complete')===true;}catch {passed=false;}
  }
  if(suite==='spa'&&passed) {
    try {const evidence=JSON.parse(readFileSync(resolve(path,'index.json'),'utf8'));passed=evidence.fullProcessRestart===true&&evidence.sessionsPerProcess?.length===2&&evidence.sessionsPerProcess.every(count=>count===2);}catch {passed=false;}
  }
  results.push({iteration,passed,exitCode:child.status,signal:child.signal,errorCode:child.error?.code??null,elapsedMs:Math.round(performance.now()-started)});save();
}
process.exitCode=results.every(result=>result.passed)?0:1;
