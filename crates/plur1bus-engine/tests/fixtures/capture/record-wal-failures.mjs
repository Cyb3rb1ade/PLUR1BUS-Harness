// Actual Node replay behavior kept as evidence for the native durable-WAL exception.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os'; import path from 'node:path'; import {pathToFileURL} from 'node:url';
assert.equal(process.version,'v24.21.0'); const root=process.env.PLUR1BUS_ENGINE_SRC; assert.ok(root);
const source=JSON.parse(readFileSync(new URL('./golden/replay-guard.json',import.meta.url))).provenance;
for(const [name,hash] of Object.entries(source.sourcesSha256))assert.equal(createHash('sha256').update(readFileSync(path.join(root,name))).digest('hex'),hash);
const {createTurnReplayGuard}=await import(pathToFileURL(path.join(root,'engine/capture/turn-replay-guard.js')));
const row='11111111-1111-1111-1111-111111111111';
const inputs=[
 {name:'corrupt',raw:'{'},
 {name:'invalid-pending',raw:'{"v":1,"entries":[{"key":"key","at":1000,"pending":"bad"}]}'},
 {name:'duplicate-keys',raw:'{"v":1,"entries":[{"key":"key","at":1000},{"key":"key","at":1001}]}'},
 {name:'write-directory',directory:true},
 {name:'expired-pending',raw:JSON.stringify({v:1,entries:[{key:'key',at:1,pending:[row]}]}),now:1_000_000_000},
 {name:'pending-capacity',full:true},
];
async function run(){const cases=[];for(const c of inputs){const dir=mkdtempSync(path.join(tmpdir(),'rx6-wal-'));try{
 const file=path.join(dir,'alpha.json');
 if(c.directory)mkdirSync(file);else if(c.full)writeFileSync(file,JSON.stringify({v:1,entries:Array.from({length:512},(_,i)=>({key:`pending-${i}`,at:1000,pending:[row]}))}));else writeFileSync(file,c.raw);
 let warnings=0,called=false,stale=null;const guard=createTurnReplayGuard({root:dir,clock:()=>c.now??1000,logger:{warn(){warnings++;}}});
 const result=await guard.run('alpha','key',async(_settled,pending)=>{called=true;stale=pending.staleRowIds;pending.onRowsPlanned([row]);return {stored:0,skipped:1,reason:'aborted'};});
 let after=null;try{after=JSON.parse(readFileSync(file,'utf8'));}catch{}
 cases.push({...c,called,stale,result,warnings,entryCount:after?.entries?.length??null,firstKey:after?.entries?.[0]?.key??null,
  rustException:'durable-fail-closed-and-pending-retention'});
}finally{rmSync(dir,{recursive:true,force:true});}}return cases;}
const cases=await run();assert.deepEqual(await run(),cases);
writeFileSync(new URL('./golden/wal-failures.json',import.meta.url),JSON.stringify({recordedFrom:{engine:source.engine,commit:source.commit,node:process.version,sourcesSha256:source.sourcesSha256},cases},null,2)+'\n');
console.log(`Recorded ${cases.length} actual Node WAL boundary cases twice`);
