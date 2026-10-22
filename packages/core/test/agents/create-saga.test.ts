import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync,existsSync,mkdirSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { layout } from "../../src/paths.ts";
import { agentCreation } from "../../src/agents/create.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { AgentCreateSaga } from "../../src/agents/saga.ts";
const owner={userId:"owner",kind:"person" as const,role:"owner" as const};
function fixture(t:{after(fn:()=>void):void},fail:string="") {
 const home=mkdtempSync(join(tmpdir(),"create-saga-"));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const config=defaults(),l=layout(home),rights=new Map<string,string>(),reserved=new Set<string>(),audit=memoryAuditSink();let attempts=0;
 const deps={config:()=>config,layout:l,clock:()=>1000,audit,people:()=>["owner","member"],secrets:async()=>[],requiredSecrets:()=>[],importMemory:async()=>{},pause:()=>{},
 reserve:async(id:string)=>{attempts++;reserved.add(id);if(fail==="files"){mkdirSync(l.agents,{recursive:true});writeFileSync(l.agentDir(id),"filesystem failure");}if(fail==="engine")throw Error("injected");},release:async(id:string)=>{reserved.delete(id);},
 set:async(id:string,value:any)=>{config.agents[id]=value;if(fail==="config")throw Error("lost-response");},removeConfig:async(id:string)=>{delete config.agents[id];},
 setRight:(id:string,user:string,right:any)=>{rights.set(`${id}:${user}`,right);if(fail==="rights")throw Error("injected");},clearRights:(id:string)=>{for(const key of rights.keys())if(key.startsWith(`${id}:`))rights.delete(key);}};
 return {l,config,rights,reserved,audit,deps,service:agentCreation(deps),attempts:()=>attempts};
}
test("same caller/key concurrent and restart retries create one agent; differing payload conflicts",async t=>{
 const s=fixture(t),payload={name:"alpha",idempotencyKey:"same-request-key-123",rights:{member:"use"}};
 const result=await Promise.all([s.service.create(payload,owner),s.service.create(payload,owner)]);assert.deepEqual(result,[{agentId:"alpha"},{agentId:"alpha",replayed:true}]);assert.equal(s.attempts(),1);
 assert.deepEqual(await agentCreation(s.deps).create(payload,owner),{agentId:"alpha",replayed:true});assert.equal(s.attempts(),1);
 await assert.rejects(s.service.create({...payload,persona:"different"},owner),e=>(e as any).error==="E_CONFLICT");
});
for(const fail of ["engine","files","config","rights"])test(`create ${fail} failure leaves no config, rights, runtime or directory`,async t=>{
 const s=fixture(t,fail);await assert.rejects(s.service.create({name:"alpha",idempotencyKey:"request-key-for-alpha"},owner));assert.equal(s.config.agents.alpha,undefined);assert.equal(s.rights.size,0);assert.equal(s.reserved.size,0);assert.equal(existsSync(s.l.agentDir("alpha")),false);
});
test("restart compensates a durable config-plus-files intent before serving",async t=>{
 const s=fixture(t);await s.service.create({name:"alpha",idempotencyKey:"request-key-for-alpha"},owner);
 const journal=new AgentCreateSaga(s.l.state),r=journal.find("request-key-for-alpha","owner")!;
 // Persist running intent to represent a killed process after effect 3, before rights completion.
 r.state="running";r.attempted=3;
 const fs=await import("node:fs");for(const name of fs.readdirSync(journal.directory))if(name.endsWith(".json"))fs.writeFileSync(join(journal.directory,name),JSON.stringify(r));s.rights.clear();
 await agentCreation(s.deps).recover();assert.equal(s.config.agents.alpha,undefined);assert.equal(existsSync(s.l.agentDir("alpha")),false);assert.equal(journal.pending().length,0);
});
// A deleted agent's name is free again: the saga retires the old incarnation as its first step and undoes that step on failure.
async function deletedFixture(t:{after(fn:()=>void):void},fail:string="") {
 const s=fixture(t,fail),{AgentLifecycle}=await import("../../src/agents/lifecycle.ts"),{readFileSync,readdirSync}=await import("node:fs");
 const lc=new AgentLifecycle({path:":memory:"});t.after(()=>lc.close());
 const deps={...s.deps,ready:(id:string)=>{lc.set(id,{paused:false});},reserve:async(id:string)=>{lc.set(id,{paused:true});return s.deps.reserve(id);},
  // Only the registration of the NEW agent is lost; restoring the old config entry must work.
  set:async(id:string,value:any)=>{s.config.agents[id]=value;if(fail==="config"&&value.persona==="new")throw Error("lost-response");},
  isDeleted:(id:string)=>lc.state(id).deleted,setDeleted:(id:string,deleted:boolean)=>{lc.set(id,deleted?{deleted:true,archived:true}:{deleted:false,archived:false,paused:false});}};
 s.config.agents.alpha={persona:"old"} as never;mkdirSync(join(s.l.agentDir("alpha"),"workspace"),{recursive:true});writeFileSync(join(s.l.agentDir("alpha"),"workspace","MEMORY.md"),"old memory");
 s.rights.set("alpha:member","manage");lc.set("alpha",{archived:true,deleted:true});
 const archives=()=>readdirSync(s.l.agents).filter(n=>n.startsWith(".deleted-alpha-"));
 return {...s,lc,deps,service:agentCreation(deps),archives,read:(p:string)=>readFileSync(p,"utf8")};
}
test("create under a deleted name is usable, drops old rights, and keeps the old data in a unique archive",async t=>{
 const s=await deletedFixture(t);
 assert.deepEqual(await s.service.create({name:"alpha",persona:"new",idempotencyKey:"request-key-for-alpha"},owner),{agentId:"alpha"});
 assert.equal(s.lc.usable("alpha"),true);assert.equal((s.config.agents.alpha as any).persona,"new");
 assert.equal(existsSync(join(s.l.agentDir("alpha"),"workspace","MEMORY.md")),false);
 const [archive,...more]=s.archives();assert.ok(archive&&more.length===0);assert.equal(s.read(join(s.l.agents,archive,"workspace","MEMORY.md")),"old memory");
 assert.equal(s.rights.has("alpha:member"),false);assert.equal(s.rights.get("alpha:owner"),"manage");
 assert.deepEqual(await s.service.create({name:"alpha",persona:"new",idempotencyKey:"request-key-for-alpha"},owner),{agentId:"alpha",replayed:true});assert.equal(s.archives().length,1);
});
for(const fail of ["engine","files","config","rights"])test(`create under a deleted name fails at ${fail}: the old incarnation is back and still deleted`,async t=>{
 const s=await deletedFixture(t,fail);
 await assert.rejects(s.service.create({name:"alpha",persona:"new",idempotencyKey:"request-key-for-alpha"},owner));
 assert.equal(s.lc.state("alpha").deleted,true);assert.equal(s.lc.usable("alpha"),false);assert.deepEqual(s.config.agents.alpha,{persona:"old"});
 assert.equal(s.read(join(s.l.agentDir("alpha"),"workspace","MEMORY.md")),"old memory");assert.deepEqual(s.archives(),[]);
});
test("restart compensates a retired name that was never completed",async t=>{
 const s=await deletedFixture(t);await s.service.create({name:"alpha",persona:"new",idempotencyKey:"request-key-for-alpha"},owner);
 const journal=new AgentCreateSaga(s.l.state),r=journal.find("request-key-for-alpha","owner")!,fs=await import("node:fs");
 // A killed process after the retire step (the only effect so far): the journal says running with one attempted step.
 fs.rmSync(s.l.agentDir("alpha"),{recursive:true,force:true});delete s.config.agents.alpha;s.rights.clear();s.lc.set("alpha",{paused:true});
 r.state="running";r.attempted=1;for(const name of fs.readdirSync(journal.directory))if(name.endsWith(".json"))fs.writeFileSync(join(journal.directory,name),JSON.stringify(r));
 await agentCreation(s.deps).recover();
 assert.equal(s.lc.state("alpha").deleted,true);assert.deepEqual(s.config.agents.alpha,{persona:"old"});assert.equal(s.read(join(s.l.agentDir("alpha"),"workspace","MEMORY.md")),"old memory");assert.deepEqual(s.archives(),[]);
});
test("a name that was not deleted is still refused",async t=>{
 const s=await deletedFixture(t);s.lc.set("alpha",{archived:false,deleted:false});
 await assert.rejects(s.service.create({name:"alpha",idempotencyKey:"request-key-for-alpha"},owner),e=>(e as any).error==="E_AGENT_EXISTS");
 assert.deepEqual(s.archives(),[]);assert.equal(s.read(join(s.l.agentDir("alpha"),"workspace","MEMORY.md")),"old memory");
});
