// Actual C2 coordinator and durable state; synthetic backend/provider boundaries only.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,readdirSync,mkdirSync,mkdtempSync,rmSync,existsSync,cpSync} from "node:fs";
import {tmpdir} from "node:os";import path from "node:path";import {pathToFileURL} from "node:url";
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,"v24.21.0");
const source=JSON.parse(readFileSync(new URL("./reembedding-sources.json",import.meta.url),"utf8"));const paths=[];
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith(".js"))paths.push(p);}}
walk(path.join(root,"engine"));walk(path.join(root,"lib"));const hash=createHash("sha256");for(const p of paths.sort()){hash.update(`${path.relative(root,p)}\0`);hash.update(readFileSync(p));hash.update("\0");}assert.equal(hash.digest("hex"),source.treeSha256);
const {createReembeddingCoordinator}=await import(pathToFileURL(path.join(root,"lib/reembedding/coordinator.js")));
const {createMigrationStateStore}=await import(pathToFileURL(path.join(root,"lib/reembedding/state-store.js")));
const {normalizeEmbeddingFingerprint}=await import(pathToFileURL(path.join(root,"lib/reembedding/fingerprint.js")));
const fp=model=>normalizeEmbeddingFingerprint({provider:"openai",model,dimensions:3},[]);
const rows=[{id:"11111111-1111-4111-8111-111111111111",text:"alpha",status:"active",vector:[1,0,0]},{id:"22222222-2222-4222-8222-222222222222",text:"beta",status:"archived",vector:[0,1,0]}];
const request={id:"migration-a",targetGeneration:"target",target:{fingerprint:fp("synthetic-target")},confirmationTtlMs:60000};
const cases=[
 {name:"happy",ops:["plan","apply","resume","validate","status"]},
 {name:"expired-before-apply",ops:["plan",{op:"apply",now:61000},"status"]},
 {name:"wrong-proof",ops:["plan",{op:"apply",wrongProof:true},"status"]},
 {name:"resume-planned",ops:["plan","resume"]},
 {name:"validate-planned",ops:["plan","validate"]},
 {name:"apply-validating",ops:["plan","apply","resume","apply"]},
 {name:"resume-validating",ops:["plan","apply","resume","resume"]},
 {name:"source-version-drift",ops:["plan",{op:"apply",version:"changed"},"status"]},
 {name:"config-drift",ops:["plan",{op:"apply",configRevision:"changed"},"status"]},
 {name:"policy-acknowledged",ops:["plan",{op:"apply",policy:{revision:2}},"resume","validate"]},
 {name:"policy-changes-after-write",policyAfterWrite:true,ops:["plan","apply","resume","validate"]},
 {name:"crash-after-write",crashAfterWrite:true,ops:["plan","apply","status","resume","resume","validate"]},
 {name:"readback-metadata",ops:["plan",{op:"apply",badReadback:true},{op:"resume",badReadback:false},"resume","validate"]},
 {name:"provider-count",ops:["plan",{op:"apply",badProvider:true},{op:"resume",badProvider:false},"resume","validate"]},
 {name:"call-budget",limits:{maxCalls:1},ops:["plan","apply","resume","status"]},
 {name:"byte-budget",limits:{maxBytes:1},ops:["plan","apply","status"]},
 {name:"validation-fails-then-recovers",ops:["plan","apply","resume",{op:"validate",semanticRecall:false},{op:"validate",semanticRecall:true}]},
 {name:"empty-source",empty:true,ops:["plan","apply","validate"]},
 {name:"expired-resume-binding",ops:["plan","apply",{op:"resume",now:61000},"validate"]},
 {name:"shutdown",ops:["plan","shutdown","apply","status"]},
];
async function run(){const out=[];for(const c of cases){const work=mkdtempSync(path.join(tmpdir(),"rx5-coordinator-"));let now=1000,version="7",configRevision="config-a",policy={revision:1},badReadback=false,badProvider=false,semanticRecall=true,crashed=false,created=false;const target=new Map(),calls=[],sourceRows=c.empty?[]:rows;const store=createMigrationStateStore({stateRoot:work,now:()=>now});const backend={
 inventoryActiveGeneration:async()=>{calls.push("inventory");return[{generation:"active",configRevision,fingerprint:fp("synthetic-source"),tables:[{tableId:"agent-a/memories",version,rowCount:sourceRows.length,estimatedBytes:1000,dimensions:3}]}];},
 createQuarantinedGeneration:async()=>{calls.push("create-target");if(created)throw Error("target generation already exists");created=true;},
 describeGeneration:async()=>({generation:"target",dimensions:3}),
 readSourceBatch:async(_,{offset,limit})=>{calls.push("source-batch");return structuredClone(sourceRows.slice(offset,offset+limit));},
 writeTargetBatch:async(_,__,rs)=>{calls.push("write-target");let added=0;for(const r of rs){if(!target.has(r.id)){target.set(r.id,structuredClone(r));added++;}}return{added,existing:rs.length-added};},
 readBackTargetRows:async(_,__,ids)=>{calls.push("readback");return ids.flatMap(id=>target.has(id)?[{...structuredClone(target.get(id)),...(badReadback?{text:"corrupted synthetic readback"}:{})}]:[]);},
 validateGeneration:async()=>{calls.push("validate-generation");if(target.size!==sourceRows.length)throw Error("wrong target count");return{tables:1,rows:target.size,dimensions:3};},close:async()=>{calls.push("close-backend");}
 };const coordinator=createReembeddingCoordinator({stateStore:store,backend,limits:{batchSize:1,...c.limits},plannerDependencies:{now:()=>now,randomBytes:()=>Buffer.alloc(32,9),statDisk:async()=>{calls.push("disk");return{freeBytes:1000000};},probeTargetProvider:async()=>{calls.push("plan-probe");return[.25,.5,.75];}},readPolicySnapshot:async()=>{calls.push("policy");return policy;},createTargetProvider:async()=>{calls.push("provider");return{embedBatch:async texts=>{calls.push("embed");return badProvider?[]:texts.map(()=>[.25,.5,.75]);},shutdown:async()=>{calls.push("close-provider");}};},afterTargetWrite:async()=>{if(c.policyAfterWrite)policy={revision:2};if(c.crashAfterWrite&&!crashed){crashed=true;throw Error("synthetic interrupted write");}},runValidationProbes:async()=>{calls.push("validation-probe");return{semanticRecall};}});
 let proof=null;const results=[];try{for(const raw of c.ops){const op=typeof raw==="string"?{op:raw}:raw;if(op.now!==undefined)now=op.now;if(op.version!==undefined)version=op.version;if(op.configRevision!==undefined)configRevision=op.configRevision;if(op.policy!==undefined)policy=op.policy;if(op.badReadback!==undefined)badReadback=op.badReadback;if(op.badProvider!==undefined)badProvider=op.badProvider;if(op.semanticRecall!==undefined)semanticRecall=op.semanticRecall;const start=calls.length;let result;try{let value;if(op.op==="plan"){const p=await coordinator.plan(request);proof=p.confirmation.token;value={plan:p.plan,planDigest:p.planDigest,record:p.record};}else if(op.op==="shutdown"){await coordinator.shutdown();value=null;}else if(op.op==="status")value=await coordinator.status(request.id);else value=await coordinator[op.op]({id:request.id,token:op.wrongProof?"invalid-proof":proof});result={value};}catch(e){result={error:e.message,code:e.code??null};}results.push({...result,calls:calls.slice(start),state:store.get(request.id),target:[...target.values()]});}out.push({...c,request,sourceFingerprint:fp("synthetic-source"),sourceRows,results});}finally{await coordinator.shutdown().catch(()=>{});rmSync(work,{recursive:true,force:true});}}
return out;}
async function nodeRestart(persist=false){
 const work=mkdtempSync(path.join(tmpdir(),"rx5-node-restart-"));
 const active=path.join(work,"active"),state=path.join(work,"state");
 cpSync(new URL("./reembedding-stores/exact-replay/",import.meta.url),path.join(active,"agent-a"),{recursive:true});
 const {createLanceGenerationBackend}=await import(pathToFileURL(path.join(root,"lib/reembedding/lance-backend.js")));
 const backend=createLanceGenerationBackend({stateRoot:state,activeRoot:active,activeGeneration:"active",activeFingerprint:fp("synthetic-source")});
 const store=createMigrationStateStore({stateRoot:state,now:()=>1000});
 const coordinator=createReembeddingCoordinator({stateStore:store,backend,
  plannerDependencies:{now:()=>1000,randomBytes:()=>Buffer.alloc(32,9),statDisk:async()=>({freeBytes:1000000}),probeTargetProvider:async()=>[.25,.5,.75]},
  createTargetProvider:async()=>({embedBatch:async texts=>texts.map(()=>[.25,.5,.75]),shutdown:async()=>{}}),
  afterTargetWrite:async()=>{throw Error("synthetic durable-write interruption");},runValidationProbes:async()=>({semanticRecall:true})});
 try{
  const plan=await coordinator.plan(request);await assert.rejects(coordinator.apply({id:request.id,token:plan.confirmation.token}),/synthetic durable-write interruption/);
  const record=store.get(request.id),manifest=await backend.describeGeneration("target"),rows=await backend.readSourceBatch("agent-a/memories",{offset:0,limit:8});
  assert.equal(record.state,"running");assert.equal(record.cursor.completedRows,0);
  assert.equal(manifest.tables["agent-a/memories"].writtenRows,1);
  await coordinator.shutdown();
  if(persist){const out=new URL("./reembedding-coordinator-store/",import.meta.url);rmSync(out,{recursive:true,force:true});cpSync(work,out,{recursive:true});}
  return{record,manifest,sourceRows:rows,proofSeed:9};
 }finally{await coordinator.shutdown();rmSync(work,{recursive:true,force:true});}
}
const recorded=await run();assert.deepEqual(await run(),recorded);
const restart=await nodeRestart(true);assert.deepEqual(await nodeRestart(),restart);
writeFileSync(new URL("./golden/reembedding-coordinator.json",import.meta.url),JSON.stringify({recordedFrom:{engine:"node",source,node:process.version},cases:recorded,restart},null,2)+"\n");console.log(`Recorded ${recorded.length} actual Node coordinator scenarios twice`);
