// RX3: actual shared-copy retract/refresh, partial failures and archive-first persistence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root); assert.equal(process.version, "v24.21.0");
const source = JSON.parse(readFileSync(new URL("./write-sources.json", import.meta.url), "utf8"));
const files = [];
function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith(".js")) files.push(file); } }
walk(path.join(root, "engine")); walk(path.join(root, "lib"));
const hash = createHash("sha256");
for (const file of files.sort()) { hash.update(`${path.relative(root, file)}\0`); hash.update(readFileSync(file)); hash.update("\0"); }
assert.equal(hash.digest("hex"), source.treeSha256);
const load = file => import(pathToFileURL(path.join(root, file)));
const { MemoryDB } = await load("engine/store/memory-db.js");
const { createDbAdapter } = await load("lib/db-adapter.js");
const { createMemoryWrite } = await load("engine/memory-ops/write.js");
const { createMemoryRead } = await load("engine/memory-ops/read.js");
const { createMemoryOpsContext } = await load("engine/memory-ops/context.js");
const digest=text=>createHash('sha256').update(text).digest('hex');
const now=1_800_000_000_000;const NativeDate=Date;
globalThis.Date=class extends NativeDate {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
const id="00000000-0000-4000-8000-000000000001";
const principal={agentId:'agent',user:'user:v1:'+digest('fixture-user'),channel:'telegram',accountId:'fixture',chat:{id:'fixture',kind:'direct'},trust:'proved'};
const agent={origin:'user',background:false};
const definitions=[
 {name:'retract-workspace',op:'forget',repeat:true}, {name:'retract-user',op:'forget',target:'user'},
 {name:'refresh-workspace',op:'correct'}, {name:'refresh-user',op:'correct',target:'user'},
 {name:'foreign-retract',op:'forget',foreign:true},{name:'foreign-refresh',op:'correct',foreign:true},
 {name:'other-user-hidden',op:'forget',target:'user',otherUser:true},
 {name:'original-gone',op:'correct',originalGone:true}, {name:'archive-failure',op:'forget',archiveFailure:true},
 {name:'retract-audit-failure',op:'forget',auditFailure:true},
 {name:'correction-embed-failure',op:'correct',embedFailure:true},
 {name:'reshare-failure',op:'correct',reshareFailure:true},
 {name:'retract-write-failure',op:'correct',retractFailure:true},
 {name:'background-denied',op:'forget',context:{origin:'user',background:true}},
];
async function record(){const cases=[];
for(const def of definitions){
 const work=mkdtempSync(path.join(tmpdir(),'rx3-shared-mutations-'));const baseDbPath=path.join(work,'store');const workspace=path.join(work,'workspace');mkdirSync(workspace);const stateDir=path.join(work,'state');
 const p={...principal,workspace:'workspace-dir:v1:'+workspace};
 const db=new MemoryDB(path.join(baseDbPath,'agent'),4);const shared=new MemoryDB(path.join(work,'shared'),4);
 const adapter=createDbAdapter({basePath:baseDbPath,getTable:async()=>db.table});
 try{
  await db.init();await shared.init();await db.store({id,text:'Synthetic source for sharing',summary:'Shared source summary',vector:[1,0,0,0],createdAt:now-1000,agentId:'agent',storedBy:'agent',scope:'agent-private',status:'active',epistemicStatus:'observed',origin:'note',category:'fact',importance:0.5});
  const original=JSON.parse(JSON.stringify((await db.table.query().toArray())[0]));
  const opsContext=createMemoryOpsContext({host:{stateDir,workspaceDir:async()=>workspace}});
  const pool={withDb:async(_a,fn)=>fn(db),withWriteDb:async(_a,fn)=>fn(db),withReadDbs:async(_a,fn)=>fn([{db,namespace:null}])};
  const sharedMemoryPool={support:()=>({supported:true}),withWorkspaceDb:async(_c,fn)=>fn(shared),withUserDb:async(_c,fn)=>fn(shared),withWorkspaceReadDb:async(_c,fn)=>fn(def.target==='user'?null:shared),withUserReadDb:async(_c,fn)=>fn(def.target==='user'?shared:null)};
  let mutating=false,calls=0;const embeddingCalls=[];
  const embeddings={embed:async text=>{if(mutating){calls++;embeddingCalls.push(text);if(def.embedFailure)throw new Error('fixture');if(def.reshareFailure&&calls===2)throw new Error('fixture');}return [0,1,0,0];}};
  const ops=createMemoryWrite({opsContext,pool,sharedMemoryPool,memoryDbAdapter:adapter,baseDbPath,embeddings});
  const initial=await ops.share(id,def.target??'workspace',p,agent);const sharedId=initial.sharedId;
  if(def.originalGone)await db.table.update({where:`id = '${id}'`,values:{status:'superseded'}});
  if(def.archiveFailure){mkdirSync(path.join(stateDir,'memory'),{recursive:true});writeFileSync(path.join(stateDir,'memory/_archive'),'blocked');}
  if(def.auditFailure)writeFileSync(path.join(workspace,'.adaptive-learning'),'blocked');
  if(def.retractFailure){const update=shared.table.update.bind(shared.table);shared.table.update=async opts=>{if(opts.values?.status==='deleted')throw new Error('fixture');return update(opts);};}
  const caller={...p,...(def.foreign?{agentId:'peer'}:{}),...(def.otherUser?{user:'user:v1:'+digest('other-user')}:{})};
  const results=[];mutating=true;
  for(let i=0;i<(def.repeat?2:1);i++)try{results.push({value:await (def.op==='forget'?ops.forget(sharedId,caller,def.context??agent):ops.correct(sharedId,'Updated shared evidence',caller,def.context??agent))});}catch(e){assert.equal(typeof e.code,'string');results.push({error:e.code,...(e.detail?{detail:e.detail}:{})});}
  const rows=JSON.parse(JSON.stringify(await db.table.query().toArray()));const copies=JSON.parse(JSON.stringify(await shared.table.query().toArray()));
  const ids=new Map([[sharedId,'old-shared']]);for(const row of rows)if(row.id!==id)ids.set(row.id,'new-source');for(const row of copies)if(row.id!==sharedId)ids.set(row.id,'new-shared');
  const auditPath=path.join(workspace,'.adaptive-learning/destructive-ops.jsonl');const audit=existsSync(auditPath)?readFileSync(auditPath,'utf8').trim().split('\n').map(JSON.parse):[];
  const archiveRoot=path.join(stateDir,'memory/_archive','agent');const archives=existsSync(archiveRoot)?readdirSync(archiveRoot).sort().map(file=>JSON.parse(readFileSync(path.join(archiveRoot,file),'utf8'))):[];
  const registry=path.join(work,'_tombstones/agent.jsonl');assert.ok(!existsSync(registry),'shared retraction must not forget the private source');
  function normalize(value,key=''){
   if(typeof value==='string'){
    if(ids.has(value))return ids.get(value);
    if(key==='shareIdempotencyKey')return '<share-key>';
    if(key==='shareProvenance'){const v=JSON.parse(value);v.sourceMemoryId=ids.get(v.sourceMemoryId)??v.sourceMemoryId;v.targetPrincipalHash='<principal-hash>';return JSON.stringify(v);}
    let out=value.replaceAll(work,'<work>');for(const [id,name]of ids)out=out.replaceAll(id,name);return out;
   }
   if(Array.isArray(value))return value.map(v=>normalize(v));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v,k)]));return value;
  }
  const project=row=>Object.fromEntries(['id','text','summary','status','scope','agentId','storedBy','ownerUserId','workspaceId','workspaceKey','epistemicStatus','sourceMemoryId','sourceAgentId','previousVersion','supersededBy'].filter(k=>k in row).map(k=>[k,row[k]]));
  const value=normalize({...def,original,principal:caller,results,rows:rows.map(project),copies:copies.map(project),audit,archives,embeddingCalls});
  for(const key of ['rows','copies','archives'])value[key].sort((a,b)=>a.id.localeCompare(b.id));cases.push(value);
 }finally{await adapter.shutdown();await db.shutdown();await shared.shutdown();rmSync(work,{recursive:true,force:true});}
}return cases;}
const cases=await record();assert.deepEqual(await record(),cases);
writeFileSync(new URL('./golden/shared-mutations.json',import.meta.url),JSON.stringify({recordedFrom:{source,node:process.version},now,agent,cases},null,2)+'\n');
console.log(`Recorded ${cases.length} shared mutation cases twice through actual Node/Lance`);
