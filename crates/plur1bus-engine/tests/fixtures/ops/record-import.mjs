// C3 actual import orchestration and Lance rows; deterministic provider and injected I/O failures.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,'v24.21.0');
const source=JSON.parse(readFileSync(new URL('./import-write-sources.json',import.meta.url),'utf8'));
const files=[];function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.name.endsWith('.js'))files.push(f);}}
walk(path.join(root,'engine'));walk(path.join(root,'lib'));const hash=createHash('sha256');
for(const f of files.sort()){hash.update(`${path.relative(root,f)}\0`);hash.update(readFileSync(f));hash.update('\0');}assert.equal(hash.digest('hex'),source.treeSha256);
const load=f=>import(pathToFileURL(path.join(root,f)));
const {createMemoryImport}=await load('engine/memory-ops/import.js');
const {importCardId}=await load('engine/memory-ops/import-id.js');
const {createMemoryOpsContext}=await load('engine/memory-ops/context.js');
const {MemoryDB}=await load('engine/store/memory-db.js');
const {contentFingerprint}=await load('lib/tombstone.js');
const now=1_800_000_000_000;const NativeDate=Date;
globalThis.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
const principal={agentId:'agent',workspace:'workspace:v1:fixture',channel:'',accountId:'',chat:{id:'',kind:'direct'},trust:'inferred'};
const agent={origin:'system',background:false};
const card={idempotencyKey:'key',text:'The project uses Rust for durable storage.',provenance:'imported',sourceRef:'fixture:source;run=run-1'};
const definitions=[
 {name:'apply-repeat',repeat:true}, {name:'dry-no-write',request:{dryRun:true}},
 {name:'duplicate-batch',cards:[card,{...card,text:'Different second text'}],repeat:true},
 {name:'duplicate-first-embed-fails',cards:[card,card],embedFailure:true},
 {name:'invalid-first-not-seen',cards:[{...card,text:''},card]},
 {name:'trim-key',cards:[{...card,idempotencyKey:'  key  '},{...card,idempotencyKey:'key'}]},
 {name:'empty-text',cards:[{...card,text:'  '}]}, {name:'invalid-kind',cards:[{...card,kind:'unknown'}]},
 {name:'explicit-category',cards:[{...card,kind:'preference',createdAt:1000.9}]},
 {name:'private-no-workspace',noWorkspace:true},
 {name:'workspace-binding',cards:[{...card,scope:'workspace'}]},
 {name:'workspace-unresolved',noWorkspace:true,cards:[{...card,scope:'workspace'}]},
 {name:'user-unresolved',cards:[{...card,scope:'user'}]},
 {name:'explicit-run',request:{importRunId:'explicit_2'}},
 {name:'no-run-no-digest',cards:[{...card,sourceRef:'fixture:no-run'}]},
 {name:'source-utf16-cut',cards:[{...card,sourceRef:'a'.repeat(499)+'😀'}]},
 {name:'key-too-long',cards:[{...card,idempotencyKey:'é'.repeat(257)}]},
 {name:'text-too-long',cards:[{...card,text:'x'.repeat(50001)}]},
 {name:'user-origin-denied',context:{origin:'user',background:false}},
 {name:'background-denied',context:{origin:'system',background:true}},
 {name:'binding-agent-mismatch',request:{principal:{...principal,agentId:'other'}}},
 {name:'ledger-fails-rollback-retry',appendFailure:true,repeat:true},
 {name:'ledger-and-rollback-fail-heals',appendFailure:true,rollbackFailure:true,repeat:true},
 {name:'backfill-untouched',seed:'untouched'}, {name:'backfill-edited',seed:'edited'},
 {name:'soft-deleted-blocked',seed:'deleted'}, {name:'unimported-reimport',seed:'unimported',repeat:true},
 {name:'ledger-without-row-blocked',seed:'receipt-only'},
 {name:'embed-count-mismatch',embedMismatch:true},
 {name:'foreign-user-existing',seed:'foreign-user'},
 {name:'forgotten-live-restored',seed:'forgotten-live'},
 {name:'tombstone-blocks-new',seed:'tombstone-only'},
 {name:'user-binding',noWorkspace:true,principal:{agentId:'agent',workspace:'workspace:v1:fixture',user:'user:v1:'+createHash('sha256').update('fixture-user').digest('hex'),channel:'telegram',accountId:'fixture',chat:{id:'fixture',kind:'direct'},trust:'proved'},cards:[{...card,scope:'user'}],repeat:true},
 {name:'dry-duplicate-follows-first',cards:[card,{...card,text:''}],request:{dryRun:true}},
];
async function record(){const cases=[];for(const def of definitions){
 const work=mkdtempSync(path.join(tmpdir(),'rx3-import-'));const baseDbPath=path.join(work,'store');const workspace=path.join(work,'workspace');mkdirSync(workspace);
 const db=new MemoryDB(path.join(baseDbPath,'agent'),4);await db.init();
 try{
  const opsContext=createMemoryOpsContext({host:{stateDir:path.join(work,'state'),workspaceDir:async()=>def.noWorkspace?'':workspace}});
  const pool={withReadOnlyReadDbs:async(_agent,fn)=>fn([{db,namespace:null}]),withWriteDb:async(_agent,fn)=>fn(db)};
  let embeds=0;const embeddings={embedBatch:async texts=>{embeds++;if(def.embedFailure)throw new Error('synthetic provider failure');return def.embedMismatch?[]:texts.map(()=>[1,0,0,0]);}};
  const ops=createMemoryImport({opsContext,pool,embeddings,baseDbPath,clock:()=>now});
  const caller=def.principal??principal;
  const req={agentId:'agent',principal:caller,cards:def.cards??[card],...def.request};const seedId=importCardId('agent','key');
  if(def.seed && !['receipt-only','tombstone-only'].includes(def.seed)){
   await ops.importCards({agentId:'agent',principal,cards:[card]},principal,agent);
   rmSync(path.join(baseDbPath,'_imports/agent.jsonl'));embeds=0;
   if(def.seed==='edited')await db.update(seedId,{text:'User edited this card after import.',updatedAt:now+5});
   if(def.seed==='foreign-user')await db.update(seedId,{scope:'user',ownerUserId:'user:v1:'+createHash('sha256').update('other-fixture-user').digest('hex')});
   if(['deleted','unimported'].includes(def.seed))await db.update(seedId,{status:'deleted',epistemicStatus:'invalidated'});
   if(def.seed==='unimported')ops.ledger.append('agent',{kind:'unimported',idempotencyKey:'key',cardId:seedId,importRunId:'run-1',at:now});
  }
  if(def.seed==='receipt-only')ops.ledger.append('agent',{idempotencyKey:'key',cardId:seedId,sourceRef:card.sourceRef,importedAt:now});
  const tombstones=[];
  if(['forgotten-live','tombstone-only'].includes(def.seed)){
   tombstones.push({schemaVersion:1,tombstoneId:'fixture-tombstone',memoryId:seedId,canonicalOriginId:seedId,agentId:'agent',scope:'agent-private',workspaceId:'',workspaceKey:'',ownerUserId:'',storedBy:'agent',deletedAt:new Date(now).toISOString(),actor:'principal:agent',actorType:'human',reason:'MemoryOps.forget',sourceOp:'forget',archiveRef:'fixture-archive',previousVersion:'',contentFingerprint:contentFingerprint(card.text),sourceFingerprint:'',refs:{},status:'committed'});
   mkdirSync(path.join(work,'_tombstones'),{recursive:true});writeFileSync(path.join(work,'_tombstones/agent.jsonl'),tombstones.map(row=>JSON.stringify(row)).join('\n')+'\n');
  }
  const rows=async()=>JSON.parse(JSON.stringify(await db.table.query().toArray(),(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v)).filter(row=>row.id!=='__schema__').sort((a,b)=>a.id.localeCompare(b.id));
  const initialRows=await rows();const initialLines=ops.ledger.readLines('agent');
  const append=ops.ledger.append;let firstFailure=!!def.appendFailure;
  ops.ledger.append=(...args)=>{if(firstFailure){firstFailure=false;throw new Error('synthetic receipt failure');}return append(...args);};
  const del=db.delete.bind(db);let deleteFailure=!!def.rollbackFailure;
  db.delete=async(...args)=>{if(deleteFailure){deleteFailure=false;throw new Error('synthetic rollback failure');}return del(...args);};
  const results=[];for(let i=0;i<(def.repeat?2:1);i++){try{results.push({value:await ops.importCards(req,caller,def.context??agent)});}catch(e){assert.equal(typeof e.code,'string');results.push({error:e.code});}}
  const finalRows=await rows();
  const sourceWorkspace=finalRows.find(row=>row.workspaceKey)?.workspaceKey;
  // Canonical temporary-path identity is normalized; all other row values remain actual Node values.
  const normalize=value=>JSON.parse(JSON.stringify(value,(k,v)=>sourceWorkspace&&k==='binding'?'__WORKSPACE_BINDING_DIGEST__':sourceWorkspace&&v===sourceWorkspace?'__WORKSPACE__':v));
  cases.push({...def,request:req,tombstones,initialRows:normalize(initialRows),initialLinesJson:JSON.stringify(normalize(initialLines)),results,rows:normalize(finalRows),linesJson:JSON.stringify(normalize(ops.ledger.readLines('agent'))),embeds});
 }finally{await db.shutdown();rmSync(work,{recursive:true,force:true});}
}return cases;}
const cases=await record();const repeated=await record();
for(let i=0;i<cases.length;i++)assert.equal(JSON.stringify(repeated[i])===JSON.stringify(cases[i]),true,`unstable case ${cases[i].name}`);
writeFileSync(new URL('./golden/import.json',import.meta.url),JSON.stringify({recordedFrom:{source,node:process.version},now,principal,agent,cases},null,2)+'\n');console.log(`Recorded ${cases.length} actual Node/Lance import cases twice`);
