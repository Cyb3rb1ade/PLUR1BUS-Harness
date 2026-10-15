import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../core/src/core.ts";
import { FakeChatProvider } from "../../core/src/session/provider.ts";
import { flatTestInternals } from "../../core/test/helpers/flat-embedder.ts";
import { layout } from "../../core/src/paths.ts";
import { AdminStore } from "../../core/src/identity/admin-store.ts";
import { memoryAuditSink } from "../src/rbac-bridge.ts";
import { createApiServer } from "../src/server.ts";
import { createCoreLink } from "../src/core-link.ts";
import { MemoryUserDirectory } from "../src/memory-stores.ts";
import { hashPassword } from "../src/password.ts";

async function setup(t: import("node:test").TestContext) {
  const home=mkdtempSync(join(tmpdir(),"p1b-http-chats-"));const cfg=defaults();cfg.agents.bernd={};cfg.agents.anna={};
  cfg.engine={neo:{enabled:false},gc:{enabled:false},obsidianBridge:{enabled:false},merging:{enabled:false},dreaming:{enabled:false},skillMiner:{enabled:false},temporalContext:{enabled:false},reranker:{enabled:false},duplicateThreshold:1.01};
  writeFileSync(layout(home).configPath,JSON.stringify(cfg));
  const people=new AdminStore({path:join(home,"state","admin.sqlite"),ownerId:"local-owner"});
  for(const [id,role] of [["alice","member"],["bob","member"],["viewer","viewer"]] as const){people.setRole(id,role,()=>{});people.setRight("bernd",id,"use");}people.close();
  const audit=memoryAuditSink();const core=createCore({home,testInternals:flatTestInternals(),chatProvider:new FakeChatProvider(),rbac:{audit},discovery:{scheduler:false},dreams:{scheduler:false}});await core.start();
  const link=createCoreLink(home);const users=new MemoryUserDirectory();const password="fixture-pass-not-a-real-secret";
  for(const [id,role] of [["alice","member"],["bob","member"],["viewer","viewer"]] as const)users.add({id,username:id,role,agentRights:{bernd:"use"},passwordHash:await hashPassword(password)});
  const api=createApiServer({core:link,users,ownerToken:randomBytes(32).toString("hex"),audit});const {url}=await api.listen();
  t.after(async()=>{await api.close();await link.close();await core.stop({budgetMs:5000});rmSync(home,{recursive:true,force:true});});
  const login=async(name:string)=>{const r=await fetch(url+"/api/v1/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:name,password})});assert.equal(r.status,200);await r.text();return r.headers.get("set-cookie")!.split(";")[0]!;};
  const call=async(cookie:string,path:string,method="GET",body?:object,extra:Record<string,string>={})=>{
    let csrf:string|undefined;if(method!=="GET"){const r=await fetch(url+"/api/v1/csrf",{headers:{cookie}});csrf=(await r.json() as {token:string}).token;}
    return fetch(url+path,{method,headers:{cookie,...(csrf?{"x-csrf-token":csrf}:{}),...(body?{"content-type":"application/json"}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});
  };
  return {home,url,core,audit,users,api,login,call};
}
test("real HTTP/core chat lifecycle, streaming, isolation, scopes and archive-first identity-bound delete",{timeout:30000},async t=>{
  const h=await setup(t),alice=await h.login("alice"),bob=await h.login("bob"),viewer=await h.login("viewer");
  const create=await h.call(alice,"/api/v1/chats","POST",{agentId:"bernd",title:"private title"});assert.equal(create.status,201,await create.clone().text());const {session}=await create.json() as any;
  const bobGet=await h.call(bob,`/api/v1/chats/${session.id}`);assert.equal(bobGet.status,404);await bobGet.text();
  const bobList=await h.call(bob,"/api/v1/chats");assert.deepEqual((await bobList.json() as any).sessions,[]);
  const foreign=await h.call(alice,"/api/v1/chats","POST",{agentId:"anna"});assert.equal(foreign.status,403);await foreign.text();
  const denied=await h.call(viewer,"/api/v1/chats","POST",{agentId:"bernd"});assert.equal(denied.status,403);await denied.text();
  const stream=await h.call(alice,`/api/v1/chats/${session.id}/messages`,"POST",{text:"hello from HTTP"},{accept:"text/event-stream"});assert.equal(stream.status,200,await stream.clone().text());const wire=await stream.text();assert.ok(wire.includes("turn.started")&&wire.includes("turn.completed"),wire);
  const sequences=[...wire.matchAll(/id: [^\n]+:(\d+)\n/g)].map(m=>Number(m[1]));assert.deepEqual(sequences,[...sequences].sort((a,b)=>a-b));
  const fork=await h.call(alice,`/api/v1/chats/${session.id}/fork`,"POST",{});assert.equal(fork.status,201,await fork.clone().text());const forkId=(await fork.json() as any).session.id;
  const forkGet=await h.call(alice,`/api/v1/chats/${forkId}`);assert.equal((await forkGet.json() as any).messages.length,2);
  const earlyDelete=await h.call(alice,`/api/v1/chats/${session.id}`,"DELETE",{});assert.equal(earlyDelete.status,409);await earlyDelete.text();
  const archive=await h.call(alice,`/api/v1/chats/${session.id}/archive`,"POST",{});assert.equal(archive.status,200);await archive.text();
  const proof=await h.call(alice,`/api/v1/chats/${session.id}`,"DELETE",{});const nonce=(await proof.json() as any).confirmation.nonce;
  const steal=await h.call(bob,`/api/v1/chats/${session.id}`,"DELETE",{nonce});assert.equal(steal.status,404);await steal.text();
  const deleted=await h.call(alice,`/api/v1/chats/${session.id}`,"DELETE",{nonce});assert.equal(deleted.status,200);assert.equal((await deleted.json() as any).purged,true);
  const minted=await h.call(alice,"/api/v1/tokens","POST",{name:"read chat",scopes:["chat:read"]});assert.equal(minted.status,201,await minted.clone().text());const token=(await minted.json() as any).token;
  const read=await fetch(h.url+"/api/v1/chats",{headers:{authorization:`Bearer ${token}`}});assert.equal(read.status,200);await read.text();
  const write=await fetch(h.url+"/api/v1/chats",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({agentId:"bernd"})});assert.equal(write.status,403);await write.text();
});
test("incognito has no durable chat/transcript and concurrent idempotent create yields one chat",{timeout:30000},async t=>{
  const h=await setup(t),cookie=await h.login("alice");const key="fixture-create-once";
  const created=await Promise.all([h.call(cookie,"/api/v1/chats","POST",{agentId:"bernd"},{"idempotency-key":key}),h.call(cookie,"/api/v1/chats","POST",{agentId:"bernd"},{"idempotency-key":key})]);
  const ids=await Promise.all(created.map(async r=>{assert.equal(r.status,201);return (await r.json() as any).session.id;}));assert.equal(ids[0],ids[1]);
  const marker="redact-probe-incognito-alpha";
  const inc=await h.call(cookie,"/api/v1/chats","POST",{agentId:"bernd",memoryMode:"incognito",title:marker});assert.equal(inc.status,201);const id=(await inc.json() as any).session.id;
  const sent=await h.call(cookie,`/api/v1/chats/${id}/messages`,"POST",{text:marker,wait:true});assert.equal(sent.status,200,await sent.clone().text());const sentResult=await sent.json() as any;assert.equal(sentResult.state,"completed",JSON.stringify(sentResult));
  const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):e.isFile()?[join(dir,e.name)]:[]);
  for(const file of walk(h.home))assert.ok(!readFileSync(file).includes(Buffer.from(marker)),`incognito marker leaked into ${file}`);
});
