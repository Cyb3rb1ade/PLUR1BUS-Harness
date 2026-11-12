// RX3: actual MemoryOps.share, ACL/sensitivity and shared-origin read behavior.
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
const identity={provider:'fixture',model:'hash-embedder',revision:'1',dimension:4,dtype:'fp32',normalization:'l2',prefixScheme:'none',instruction:''};
const definitions=[
 {name:'identified-target',identified:true},{name:'identified-wrong-width',identified:true,wrongWidth:true},
 {name:'identified-wrong-provider',identified:true,wrongProvider:true},{name:'identified-provider-missing',identified:true,noProvider:true},
 {name:'workspace-repeat',repeat:true}, {name:'user-repeat',target:'user',repeat:true},
 {name:'existing-category-allowed',row:{category:'established-category'}},
 {name:'sensitive-category',row:{category:'health'}},{name:'sensitive-allowed',row:{category:'health'},allowSensitive:true},
 {name:'core-approval',row:{memoryClass:'core'}},{name:'permanent-approval',row:{neverForget:1}},
 {name:'importance-approval',row:{importance:0.9}},{name:'importance-below',row:{importance:0.899}},
 {name:'foreign-hidden',row:{agentId:'foreign',storedBy:'foreign'}},{name:'owner-conflict',row:{storedBy:'foreign'}},
 {name:'deleted-hidden',row:{status:'deleted'}},{name:'invalidated-hidden',row:{epistemicStatus:'invalidated'}},{name:'expired-hidden',row:{expiresAt:now-1}},
 {name:'system-denied',context:{origin:'system',background:false}},{name:'background-denied',context:{origin:'user',background:true}},
 {name:'inferred-denied',principal:{trust:'inferred'}},{name:'user-unproved',target:'user',principal:{user:null}},
 {name:'unsupported-before-id',unsupported:true,id:'invalid'},{name:'invalid-id',id:'invalid'},
 {name:'missing-id',id:'00000000-0000-4000-8000-000000000099'},
 {name:'embedding-failure',embedFailure:true},{name:'source-changed',sourceChanged:true},
 {name:'wrong-width',wrongWidth:true},{name:'no-workspace',noWorkspace:true},
];
async function record(){const cases=[];
 for(const definition of definitions){
  const work=mkdtempSync(path.join(tmpdir(),'rx3-shares-'));const baseDbPath=path.join(work,'store');const workspace=path.join(work,'workspace');mkdirSync(workspace);
  const workspacePrincipal='workspace-dir:v1:'+workspace;
  const p={...principal,workspace:workspacePrincipal,...definition.principal};
  const privateDb=new MemoryDB(path.join(baseDbPath,'agent'),4);const workspaceDb=new MemoryDB(path.join(work,'shared-workspace'),4,null,{identity:definition.identified?identity:null});const userDb=new MemoryDB(path.join(work,'shared-user'),4,null,{identity:definition.identified?identity:null});
  const adapter=createDbAdapter({basePath:baseDbPath,getTable:async()=>privateDb.table});
  try{
   for(const db of [privateDb,workspaceDb,userDb])await db.init();
   await privateDb.store({id,text:'Synthetic source for sharing',summary:'Shared source summary',vector:[1,0,0,0],createdAt:now-1000,agentId:'agent',storedBy:'agent',scope:'agent-private',status:'active',epistemicStatus:'observed',origin:'note',category:'fact',importance:0.5,...definition.row});
   const original=JSON.parse(JSON.stringify((await privateDb.table.query().toArray())[0]));
   const opsContext=createMemoryOpsContext({host:{stateDir:path.join(work,'state'),workspaceDir:async()=>definition.noWorkspace?'':workspace}});
   const pool={withDb:async(_a,fn)=>fn(privateDb),withWriteDb:async(_a,fn)=>fn(privateDb),withReadDbs:async(_a,fn)=>fn([{db:privateDb,namespace:null}])};
   const sharedMemoryPool={...(definition.identified?{identity}:{}),support:()=>({supported:!definition.unsupported,reason:'fixture'}),withWorkspaceDb:async(_c,fn)=>fn(workspaceDb),withUserDb:async(_c,fn)=>fn(userDb),withWorkspaceReadDb:async(_c,fn)=>fn(workspaceDb),withUserReadDb:async(_c,fn)=>fn(userDb)};
   const embedCalls=[];const embeddings={...(definition.identified?{identity:definition.noProvider?undefined:{...identity,...(definition.wrongProvider?{revision:'different'}:{})}}:{}),embed:async text=>{embedCalls.push(text);if(definition.embedFailure)throw new Error('fixture');if(definition.sourceChanged)await privateDb.table.update({where:`id = '${id}'`,values:{text:'changed while embedding'}});return definition.wrongWidth?[1,0]:[0,1,0,0];}};
   const ops=createMemoryWrite({opsContext,pool,sharedMemoryPool,memoryDbAdapter:adapter,baseDbPath,embeddings});
   const read=createMemoryRead({opsContext,pool,sharedMemoryPool,baseDbPath,embeddings});
   const results=[];for(let i=0;i<(definition.repeat?2:1);i++){try{results.push({value:await ops.share(definition.id??id,definition.target??'workspace',p,definition.context??agent,{allowSensitive:definition.allowSensitive===true})});}catch(e){assert.equal(typeof e.code,'string');results.push({error:e.code});}}
   const workspaceRows=JSON.parse(JSON.stringify(await workspaceDb.table.query().toArray()));const userRows=JSON.parse(JSON.stringify(await userDb.table.query().toArray()));
   const shows=[];for(const row of [...workspaceRows,...userRows])shows.push(await read.show(row.id,p,agent));
   const list=await read.list({since:0,limit:100},p,agent).catch(e=>({error:e.code}));
   const after=JSON.parse(JSON.stringify((await privateDb.table.query().toArray())[0]));
   const ids=new Map([...workspaceRows,...userRows].map((row,i)=>[row.id,`shared-${i+1}`]));
   function normalize(value,key=''){
    if(typeof value==='string'){
     if(ids.has(value))return ids.get(value);
     if(key==='shareIdempotencyKey' && (definition.target??'workspace')==='workspace')return '<workspace-share-key>';
     if(key==='shareProvenance'){let parsed=JSON.parse(value);if(parsed.targetScope==='workspace')parsed.targetPrincipalHash='<workspace-hash>';return JSON.stringify(parsed);}
     return value.replaceAll(work,'<work>');
    }
    if(Array.isArray(value))return value.map(v=>normalize(v));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v,k)]));return value;
   }
   cases.push(normalize({...definition,principal:p,original,results,workspaceRows,userRows,shows,list,after,embedCalls}));
  }finally{await adapter.shutdown();for(const db of [privateDb,workspaceDb,userDb])await db.shutdown();rmSync(work,{recursive:true,force:true});}
 }return cases;
}
const cases=await record();assert.deepEqual(await record(),cases);
writeFileSync(new URL('./golden/shares.json',import.meta.url),JSON.stringify({recordedFrom:{source,node:process.version},now,agent,cases},null,2)+'\n');
console.log(`Recorded ${cases.length} share/ACL/sensitivity cases twice with actual Node/Lance`);
