// Actual A1 SQLite stats reference. Output must only be changed by this recorder.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const pin='9b935ce1f970bd92a931aa99a58c620669c8085f';
const source=process.env.PLUR1BUS_ENGINE_SRC, gitRoot=process.env.PLUR1BUS_ENGINE_GIT;
if(!source||!gitRoot||process.version!=='v24.21.0') throw new Error('verified source, Git source and Node24.21 required');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sources=['package.json','engine/recall/recall-stats.js','lib/input-limits.js','lib/sql-safety.js','lib/log-redact.js'].map(path=>{
 const bytes=readFileSync(join(source,path));
 assert.equal(sha(bytes),sha(execFileSync('git',['-C',gitRoot,'show',`${pin}:${path}`])));
 return {path,sha256:sha(bytes)};
});
const {createRecallStats}=await import(pathToFileURL(join(source,'engine/recall/recall-stats.js')).href);
const A='00000000-0000-4000-8000-000000000001', B='00000000-0000-4000-8000-000000000002';
const C='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const key=Buffer.alloc(32,7).toString('hex'); // Synthetic deterministic key, passed to HMAC as ASCII, exactly as Node.
const record=(ids,query,now,agent='alpha')=>({op:'record',ids,query,now,agent});
const read=(ids,agent='alpha')=>({op:'read',ids,agent});
const cases=[
 {name:'empty-read',actions:[read(null)]},
 {name:'empty-record',uninitialized:true,actions:[record([], '', -1)]},
 {name:'duplicate-ids',actions:[record([A,A,B],'Synthetic exact query',20),read([A,B,A])]},
 {name:'same-query-repeats',actions:[record([A],'Synthetic exact query',20),record([A],'Synthetic exact query',30),read([A])]},
 {name:'exact-query-equality',actions:[record([A],'Synthetic query',20),record([A],' Synthetic query ',30),record([A],'synthetic query',40),read(null)]},
 {name:'unicode-is-not-normalized',actions:[record([A],'Café 🚀',20),record([A],'Cafe\u0301 🚀',30),read(null)]},
 {name:'id-case-preserved',actions:[record([C,C.toLowerCase()],'Synthetic query',20),read(null)]},
 {name:'agent-isolation',actions:[record([A],'Synthetic query',20),record([A],'Synthetic query',30,'beta'),read([A]),read([A],'beta')]},
 {name:'timestamp-is-monotonic',actions:[record([A],'One query',30),record([A],'Two query',20),read(null)]},
 {name:'missing-explicit-zero',actions:[read([B,A,B])]},
 {name:'legacy-counter',legacy:{id:A,recalls:8,lastRecalledAt:100},actions:[read(null),record([A],'New synthetic query',120),read([A])]},
 {name:'legacy-null-time',legacy:{id:A,recalls:8,lastRecalledAt:null},actions:[record([A],'New synthetic query',120),read([A])]},
 {name:'future-schema-refused',version:2,actions:[read(null),record([A],'Synthetic query',20)]},
 {name:'invalid-values',actions:[record(['bad'],'Synthetic query',20),record([A],'',20),record([A],'   ',20),record([A],'Synthetic query',-1),record([A],'Synthetic query',0.5),read(['bad'])]},
];
function snapshot(stats,agent){
 const file=stats.path(agent);
 if(!existsSync(file))return null;
 const db=new DatabaseSync(file);
 try{return {version:db.prepare('PRAGMA user_version').get().user_version,stats:db.prepare('SELECT * FROM stats ORDER BY id').all(),queries:db.prepare('SELECT * FROM queries ORDER BY id,digest').all()};}finally{db.close();}
}
function run(){return cases.map(scenario=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'a1-recall-stats-')));
 const stats=createRecallStats({baseDbPath:root});
 try{
  if(!scenario.uninitialized){
   for(const agent of ['alpha','beta']){
    stats.read(agent,[]);
    const db=new DatabaseSync(stats.path(agent));
    db.prepare('UPDATE metadata SET value=? WHERE key=?').run(key,'query-hmac-key');
    if(scenario.legacy&&agent==='alpha'){
     const l=scenario.legacy;db.prepare('INSERT INTO stats VALUES (?,?,?)').run(l.id,l.recalls,l.lastRecalledAt);
     db.exec('PRAGMA user_version=0');
    }
    if(scenario.version)db.exec(`PRAGMA user_version=${scenario.version}`);
    db.close();
   }
  }
  const steps=scenario.actions.map(action=>{
   let result=null,error=false;
   try{if(action.op==='read')result=stats.read(action.agent,action.ids);else stats.record(action.agent,action.ids,action.query,action.now);}catch{error=true;}
   return {action,result,error,state:snapshot(stats,action.agent)};
  });
  return {scenario,steps};
 }finally{rmSync(root,{recursive:true,force:true});}
});}
const previousFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('network forbidden');};
try{
 const recorded=run();assert.deepEqual(run(),recorded);
 const output=JSON.stringify({pin,node:process.version,sourceHashes:sources,boundaries:{sqlite:'actual A1 record/read and transactions',key:'synthetic Buffer.alloc(32,7).toString(hex), ASCII HMAC key',providers:'none',normalization:'none; explicit clocks and seeded synthetic key'},cases:recorded},null,2)+'\n';
 const path=join(dirname(fileURLToPath(import.meta.url)),'golden/recall-stats.json');
 mkdirSync(dirname(path),{recursive:true});writeFileSync(path,output);
 console.log(`Recorded ${recorded.length} A1 stats cases twice; SHA-256 ${sha(output)}`);
}finally{globalThis.fetch=previousFetch;}
