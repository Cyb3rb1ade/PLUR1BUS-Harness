// RX3: actual canonical workspace policy store and maintenance/enablement guard.
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
const {createWorkspacePolicyStore}=await load('lib/workspace-policy.js');
const {createWorkspacePolicyGuard}=await load('lib/workspace-policy-guard.js');
const now=1_800_000_000_000;const identity={agentId:'agent',workspaceIdentity:'workspace:v1:fixture'};
const initial={...identity,enabled:false,expectedRevision:0,actorId:'user:v1:fixture'};
const definitions=[
 {name:'default',ops:[{kind:'get',value:identity},{kind:'list'}]},
 {name:'disable-enable',ops:[{kind:'set',value:initial},{kind:'get',value:identity},{kind:'set',value:{...initial,enabled:true,expectedRevision:1}},{kind:'list'}]},
 {name:'revision-conflict',ops:[{kind:'set',value:initial},{kind:'set',value:initial},{kind:'get',value:identity}]},
 {name:'independent-tuples',ops:[{kind:'set',value:initial},{kind:'set',value:{...initial,agentId:'Agent'}},{kind:'set',value:{...initial,workspaceIdentity:'workspace:v1:other'}},{kind:'list'}]},
 {name:'canonical-bare',ops:[{kind:'set',value:{...initial,workspaceIdentity:'  fixture ',actorId:'  actor  '}},{kind:'get',value:identity}]},
 ...[
 ['invalid-agent',{...initial,agentId:'../bad'}],['invalid-agent-dot',{...initial,agentId:'a.b'}],['invalid-agent-long',{...initial,agentId:'a'.repeat(65)}],['leading-underscore',{...initial,agentId:'_agent'}],['nested-workspace',{...initial,workspaceIdentity:'workspace:v1:workspace:v1:bad'}],
 ['invalid-prefix',{...initial,workspaceIdentity:'workspace:v2:bad'}],['missing-actor',{...initial,actorId:''}],['long-actor',{...initial,actorId:'a'.repeat(129)}],
 ['fractional-revision',{...initial,expectedRevision:0.5}],['negative-revision',{...initial,expectedRevision:-1}],['unsafe-revision',{...initial,expectedRevision:2**53}],['invalid-enabled',{...initial,enabled:'false'}],
 ].map(([name,value])=>({name,ops:[{kind:'set',value},{kind:'list'}]})),
 {name:'unknown-input-ignored',ops:[{kind:'set',value:{...initial,unrelated:true}}]},
 {name:'corrupt-json',raw:'{invalid',ops:[{kind:'get',value:identity},{kind:'set',value:initial},{kind:'list'}]},
 {name:'unknown-state-field',state:{schemaVersion:1,revision:0,policies:{},unknown:true},ops:[{kind:'list'}]},
 {name:'future-schema',state:{schemaVersion:2,revision:0,policies:{}},ops:[{kind:'list'}]},
 {name:'mismatched-record-key',state:{schemaVersion:1,revision:1,policies:{wrong:{...identity,enabled:true,revision:1,updatedAt:now,actorId:'actor'}}},ops:[{kind:'list'}]},
 {name:'guard-default',guard:true}, {name:'guard-disabled',guard:true,disable:true}, {name:'guard-maintenance',guard:true,maintenance:true}, {name:'guard-missing-identity',guard:true,missing:true}, {name:'guard-corrupt',guard:true,raw:'{invalid'},
];
async function record(){const cases=[];for(const def of definitions){const work=mkdtempSync(path.join(tmpdir(),'rx3-policy-'));try{
 const statePath=path.join(work,'control/workspace-policy.json');if(def.raw!==undefined||def.state){mkdirSync(path.dirname(statePath));writeFileSync(statePath,def.raw??JSON.stringify(def.state));}
 const store=createWorkspacePolicyStore({stateRoot:work,now:()=>now});const results=[];const invalidations=[];
 const invoke=async fn=>{try{results.push({value:await fn()});}catch(e){results.push({error:e.code??'invalid',...(e.current?{current:e.current}:{})});}};
 if(def.guard){
  const guard=createWorkspacePolicyGuard({store,invalidate:async identity=>invalidations.push(identity),maintenanceGate:{status:()=>({active:!!def.maintenance})}});
  const ctx=def.missing?{}:identity;if(def.disable)await invoke(()=>guard.set({memoryCtx:ctx,enabled:false,expectedRevision:0,actorId:'actor'}));
  await invoke(()=>guard.decision(ctx));await invoke(()=>guard.requireEnabled(ctx));await invoke(()=>guard.automatic(ctx));
 }else for(const op of def.ops)await invoke(()=>store[op.kind](op.value));
 const persisted=existsSync(statePath)?readFileSync(statePath,'utf8'):null;let state=null;if(persisted!==null)try{state=JSON.parse(persisted);}catch{state={raw:persisted};}
 cases.push({...def,initialState:def.state??null,results,invalidations,state});
}finally{rmSync(work,{recursive:true,force:true});}}return cases;}
const cases=await record();assert.deepEqual(await record(),cases);
writeFileSync(new URL('./golden/workspace-policy.json',import.meta.url),JSON.stringify({recordedFrom:{source,node:process.version},now,cases},null,2)+'\n');console.log(`Recorded ${cases.length} workspace policy/guard cases twice`);
