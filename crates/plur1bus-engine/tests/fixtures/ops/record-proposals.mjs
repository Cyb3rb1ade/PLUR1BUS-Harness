// RX3: actual proposal filing/list/accept/reject, durable records and host events.
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
const {createMemoryProposals}=await load('engine/memory-ops/proposals.js');
const {createProposalStore}=await load('engine/memory-ops/proposal-store.js');
const definitions=[
 {name:'pending-repeat',repeat:true},{name:'user-pending',target:'user'},
 {name:'accept',resolve:'accept'},{name:'reject-repeat',resolve:'reject',repeatResolve:true,note:'synthetic note'},
 {name:'stale-changed',resolve:'accept',changed:true},{name:'stale-gone',resolve:'accept',gone:true},
 {name:'foreign-resolve',resolve:'accept',foreignResolve:true},{name:'other-user-resolve',target:'user',resolve:'accept',otherUser:true},
 {name:'unsupported-accept',resolve:'accept',unsupported:true},{name:'refresh-failure',resolve:'accept',embedFailure:true},
 {name:'own-shared-invalid',own:true},{name:'private-invalid',private:true},{name:'same-text',same:true},
 {name:'blank',text:' '},{name:'oversize-note',note:'x'.repeat(501)},{name:'missing-copy',missing:true},
 {name:'background-denied',background:true},{name:'filing-audit-failure',auditFailure:true},
 {name:'reject-audit-failure',resolve:'reject',resolveAuditFailure:true},
 {name:'corrupt-unrelated-counter',corrupt:true},
];
async function record(){const cases=[];
 for(const def of definitions){
  const work=mkdtempSync(path.join(tmpdir(),'rx3-proposals-'));const baseDbPath=path.join(work,'store');const workspace=path.join(work,'workspace');mkdirSync(workspace);const stateDir=path.join(work,'state');
  const p={...principal,workspace:'workspace-dir:v1:'+workspace};const proposer={...p,agentId:def.own||def.private?'agent':'peer'};
  const db=new MemoryDB(path.join(baseDbPath,'agent'),4);const shared=new MemoryDB(path.join(work,'shared'),4);
  const adapter=createDbAdapter({basePath:baseDbPath,getTable:async()=>db.table});
  try{
   await db.init();await shared.init();await db.store({id,text:'Synthetic source for sharing',summary:'Shared source summary',vector:[1,0,0,0],createdAt:now-1000,agentId:'agent',storedBy:'agent',scope:'agent-private',status:'active',epistemicStatus:'observed',origin:'note',category:'fact',importance:0.5});
   const original=JSON.parse(JSON.stringify((await db.table.query().toArray())[0]));const events=[];
   const host={stateDir,workspaceDir:async()=>workspace,events:{emit:(name,payload)=>events.push({name,payload})}};
   const opsContext=createMemoryOpsContext({host});
   const pool={withDb:async(_a,fn)=>fn(db),withWriteDb:async(_a,fn)=>fn(db),withReadDbs:async(_a,fn)=>fn([{db,namespace:null}])};
   let resolving=false;
   const sharedMemoryPool={support:()=>({supported:!resolving||!def.unsupported,reason:'fixture'}),withWorkspaceDb:async(_c,fn)=>fn(shared),withUserDb:async(_c,fn)=>fn(shared),withWorkspaceReadDb:async(_c,fn)=>fn(def.target==='user'?null:shared),withUserReadDb:async(_c,fn)=>fn(def.target==='user'?shared:null)};
   const embeddings={embed:async()=>{if(resolving&&def.embedFailure)throw new Error('fixture');return [0,1,0,0];}};
   const writer=createMemoryWrite({opsContext,pool,sharedMemoryPool,memoryDbAdapter:adapter,baseDbPath,embeddings});
   const initial=await writer.share(id,def.target??'workspace',p,agent);const sharedId=initial.sharedId;
   const store=createProposalStore({baseDbPath});const ops=createMemoryProposals({opsContext,sharedOps:writer.shared,store,memoryDbAdapter:adapter,host,clock:()=>now,sharedMemoryPool});
   if(def.auditFailure)writeFileSync(path.join(workspace,'.adaptive-learning'),'blocked');
   const results=[];let proposalId;
   const attempt=async fn=>{try{const value=await fn();results.push({value});return value;}catch(e){results.push({error:e.code,...(e.detail?{detail:e.detail}:{})});return null;}};
   const text=def.text??(def.same?original.text:'Proposal changes synthetic evidence');
   for(let i=0;i<(def.repeat?2:1);i++){const filed=await attempt(()=>ops.propose(def.private?id:def.missing?'00000000-0000-4000-8000-000000000099':sharedId,text,proposer,def.background?{...agent,background:true}:agent,def.note!==undefined?{note:def.note}:{}));proposalId??=filed?.proposalId;}
   if(def.changed)await shared.table.update({where:`id = '${sharedId}'`,values:{text:'changed after proposal'}});
   if(def.gone)await shared.table.update({where:`id = '${sharedId}'`,values:{status:'deleted'}});
   if(def.corrupt){mkdirSync(path.join(work,'_proposals','foreign'),{recursive:true});writeFileSync(path.join(work,'_proposals','foreign','broken.json'),'{broken');}
   if(def.resolveAuditFailure){rmSync(path.join(workspace,'.adaptive-learning'),{recursive:true,force:true});writeFileSync(path.join(workspace,'.adaptive-learning'),'blocked');}
   const resolver={...p,...(def.foreignResolve?{agentId:'peer'}:{}),...(def.otherUser?{user:'user:v1:'+digest('other-user')}:{})};
   if(def.resolve&&proposalId){resolving=true;for(let i=0;i<(def.repeatResolve?2:1);i++)await attempt(()=>def.resolve==='accept'?ops.accept(proposalId,resolver,agent):ops.reject(proposalId,resolver,agent,{note:'declined synthetic proposal'}));}
   const lists={};for(const[name,who]of Object.entries({sharer:p,proposer,foreign:{...p,agentId:'foreign'},otherUser:{...p,user:'user:v1:'+digest('other-user')}}))lists[name]=await ops.list({},who,agent);
   const proposalRoot=path.join(work,'_proposals/agent');const records=existsSync(proposalRoot)?readdirSync(proposalRoot).filter(file=>file.endsWith('.json')).map(file=>JSON.parse(readFileSync(path.join(proposalRoot,file),'utf8'))):[];
   const rows=JSON.parse(JSON.stringify(await db.table.query().toArray()));const copies=JSON.parse(JSON.stringify(await shared.table.query().toArray()));
   const ids=new Map([[sharedId,'old-shared']]);for(const row of rows)if(row.id!==id)ids.set(row.id,'new-source');for(const row of copies)if(row.id!==sharedId)ids.set(row.id,'new-shared');for(const record of records)ids.set(record.id,'proposal');
   function normalize(v,key=''){if(typeof v==='string'){if(ids.has(v))return ids.get(v);if(key==='poolKey'&&v.startsWith('w-'))return '<workspace-pool>';let out=v.replaceAll(work,'<work>');for(const[id,name]of ids)out=out.replaceAll(id,name);return out;}if(Array.isArray(v))return v.map(item=>normalize(item));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalize(x,k)]));return v;}
   cases.push(normalize({...def,original,principal:p,proposer,resolver,results,records,lists,events}));
  }finally{await adapter.shutdown();await db.shutdown();await shared.shutdown();rmSync(work,{recursive:true,force:true});}
 }return cases;
}
const cases=await record();assert.deepEqual(await record(),cases);
writeFileSync(new URL('./golden/proposals.json',import.meta.url),JSON.stringify({recordedFrom:{source,node:process.version},now,agent,cases},null,2)+'\n');
console.log(`Recorded ${cases.length} actual proposal cases twice`);
