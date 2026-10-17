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
