// Real Core + pinned engine/storage + HTTP. Only model inference is replaced by the existing fixed-vector test seam.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes,randomUUID } from "node:crypto";
import { mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { connect } from "../../core/test/helpers/connect.ts";
import { createCore } from "../../core/src/core.ts";
import { flatTestInternals } from "../../core/test/helpers/flat-embedder.ts";
import { createCoreLink } from "../src/core-link.ts";
import { createApiServer } from "../src/server.ts";
import { AccountStore,type CorePerson } from "../src/account-store.ts";
import { hashPassword } from "../src/password.ts";
import { memoryAuditSink } from "../src/rbac-bridge.ts";
test("M3 K3 real HTTP Member sees only shared agents and their own user-memory; caller spoof, foreign card and private agent are denied",{timeout:60000},async t=>{
 const home=mkdtempSync(join(tmpdir(),"m3-member-memory-")),cfg=defaults();cfg.agents.shared={};cfg.agents.private={};
 cfg.engine={neo:{enabled:false},gc:{enabled:false},obsidianBridge:{enabled:false},merging:{enabled:false},dreaming:{enabled:false},skillMiner:{enabled:false},temporalContext:{enabled:false},conversationReactivationRecall:{enabled:false},reranker:{enabled:false},duplicateThreshold:1.01,runtime:{recallTimeoutMs:10000}};
 writeFileSync(join(home,"config.json"),JSON.stringify(cfg));const audit=memoryAuditSink(),core=createCore({home,testInternals:flatTestInternals(),rbac:{audit},discovery:{scheduler:false},dreams:{scheduler:false}});await core.start();
 const local=await connect({address:core.address,token:core.token}),link=createCoreLink(home),accounts=new AccountStore({path:join(home,"state","api","member-test.sqlite"),resolve:async userId=>(await link.serviceCall!<{person:CorePerson|null}>("admin.api.person.resolve",{userId})).person});
 const owner={channel:"cli" as const,accountId:"seed-owner",userId:"fixture-owner"},members:{id:string;name:string;caller:typeof owner;sharedId:string;privateId:string}[]=[];
 t.after(async()=>{await local.close();await link.close();accounts.close();await core.stop({budgetMs:5000});rmSync(home,{recursive:true,force:true});});
 const password=randomBytes(24).toString("base64url");
 for(const [name,fact]of [["alice","Please remember that the orchard inventory meeting is on Wednesday at fourteen."],["bob","Please remember that the office plants need water on Mondays."]] as const){
  const human=await local.call<{id:string}>("identity.human.create",{caller:owner,displayName:name});const caller={channel:"cli" as const,accountId:`seed-${name}`,userId:`${name}-handle`};
  await local.call("identity.link",{caller:owner,humanId:human.id,identity:caller});await local.call("user.role.set",{userId:human.id,role:"member"});await local.call("agent.rights.set",{agentId:"shared",userId:human.id,right:"use"});
  await accounts.createPending(human.id,name,await hashPassword(password));await accounts.activate(human.id);
  // Seed user copies from a different source agent: engine D31 deduplicates a source and its shared copy on the source agent.
  const list=async()=>await local.call<{items:{id:string;scope:string}[]}>("memory.list",{caller,agentId:"private",since:0});const before=new Set((await list()).items.map(c=>c.id));
  const captured=await local.call<{stored:number}>("memory.capture",{caller,agentId:"private",runId:randomUUID(),messages:[{role:"user",content:fact},{role:"assistant",content:"Noted."}],wait:true,waitMs:10000});assert.ok(captured.stored>=1);
  const added=(await list()).items.filter(c=>!before.has(c.id));assert.equal(added.length,1);assert.equal(added[0]!.scope,"agent-private");
  let shared:{sharedId:string};try{shared=await local.call("memory.share",{caller,agentId:"private",id:added[0]!.id,target:"user"});}catch(e){if(process.platform==="win32"&&(e as any).error==="E_STORAGE"&&(e as any).reason==="storage"){
   await assert.rejects(local.call("memory.share",{caller,agentId:"private",id:added[0]!.id,target:"user"}),(error:unknown)=>(error as any).error==="E_NOT_AVAILABLE"&&(error as any).reason==="unsupported"&&(error as any).ids?.reason==="unsafe-root");t.skip("elevated Windows shared root refused by actual engine ACL (unsafe-root); positive K3 acceptance requires supported shared-memory host");return;
  }throw e;}
  members.push({id:human.id,name,caller,sharedId:shared.sharedId,privateId:added[0]!.id});
 }
 const api=createApiServer({core:link,users:accounts,accounts,ownerToken:randomBytes(32).toString("hex"),audit,rateClasses:{auth:{capacity:1000,refillPerSec:1000},read:{capacity:1000,refillPerSec:1000},write:{capacity:1000,refillPerSec:1000}}});const{url}=await api.listen();t.after(()=>api.close());
 const login=async(name:string)=>{const r=await fetch(url+"/api/v1/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:name,password})});assert.equal(r.status,200,await r.clone().text());return r.headers.get("set-cookie")!.split(";")[0]!;};
 let id=0;const rpc=async(cookie:string,method:string,params:object)=>{const csrf=await(await fetch(url+"/api/v1/csrf",{headers:{cookie}})).json() as any;const r=await fetch(url+"/rpc",{method:"POST",headers:{cookie,"content-type":"application/json","x-csrf-token":csrf.token},body:JSON.stringify({jsonrpc:"2.0",id:++id,method,params})});assert.equal(r.status,200);return await r.json() as any;};
 const alice=members[0]!,bob=members[1]!,cookies=new Map(await Promise.all(members.map(async m=>[m.id,await login(m.name)] as const)));
 for(const [member,other]of [[alice,bob],[bob,alice]] as const){
  const cookie=cookies.get(member.id)!;const agents=await fetch(url+"/api/v1/agents",{headers:{cookie}});assert.equal(agents.status,200);assert.deepEqual((await agents.json() as any).agents.map((a:any)=>a.agentId),["shared"]);
  const listed=await rpc(cookie,"memory.list",{caller:member.caller,agentId:"shared",since:0});assert.ok(listed.result,JSON.stringify(listed));assert.deepEqual(listed.result.items.map((card:any)=>({id:card.id,scope:card.scope})),[{id:member.sharedId,scope:"user"}],JSON.stringify(listed));
  const own=await rpc(cookie,"memory.show",{caller:member.caller,agentId:"shared",id:member.sharedId});assert.equal(own.result.card.id,member.sharedId);assert.equal(own.result.card.scope,"user");
  const foreign=await rpc(cookie,"memory.show",{caller:member.caller,agentId:"shared",id:other.sharedId});assert.equal(foreign.error.data.error,"E_NOT_FOUND",JSON.stringify(foreign));
  const agentPrivate=await rpc(cookie,"memory.show",{caller:member.caller,agentId:"shared",id:member.privateId});assert.equal(agentPrivate.error.data.error,"E_NOT_FOUND");
  const spoof=await rpc(cookie,"memory.list",{caller:other.caller,agentId:"shared",since:0});assert.equal(spoof.error.data.error,"E_DENIED");assert.equal(spoof.error.data.reason,"caller-not-linked");
  const target=await rpc(cookie,"memory.list",{caller:member.caller,agentId:"shared",since:0,targetUserId:other.id});assert.equal(target.error.data.error,"E_DENIED");
  const privateAgent=await rpc(cookie,"memory.list",{caller:member.caller,agentId:"private",since:0});assert.equal(privateAgent.error.data.error,"E_DENIED");
  assert.ok(!JSON.stringify(listed).includes(other.sharedId));
 }
 await local.call("agent.rights.set",{agentId:"shared",userId:alice.id,right:null});const oldSession=await fetch(url+"/api/v1/agents",{headers:{cookie:cookies.get(alice.id)!}});assert.equal(oldSession.status,401);await oldSession.text();const refreshed=await login(alice.name);const revoked=await rpc(refreshed,"memory.show",{caller:alice.caller,agentId:"shared",id:alice.sharedId});assert.equal(revoked.error.data.error,"E_DENIED");
});
