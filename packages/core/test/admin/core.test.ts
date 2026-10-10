import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import type { Principal } from "../../src/rbac/types.ts";
const caller = { channel: "cli", accountId: "offline", userId: "owner" };
test("core registers administration, persists lifecycle, blocks turns/jobs and uses stored roles", async t => {
  const home=tempDir("admin-core-"); const config=defaults(); config.agents.alpha={ displayName:"Alpha" };
  config.engine={ reranker:{enabled:false}, neo:{enabled:false}, dreaming:{enabled:false}, gc:{enabled:false} };
  writeFileSync(`${home}/config.json`,JSON.stringify(config));
  let who: Principal = { userId:"local-owner",role:"owner",kind:"person" };
  const core=createCore({ home,testInternals:flatTestInternals(),chatProvider:new FakeChatProvider(),rbac:{resolve:()=>who},dreams:{scheduler:false} });
  await core.start(); const c=await connect({address:core.address,token:core.token});
  t.after(async()=>{await c.close();await core.stop({budgetMs:5000});});
  await c.call("agent.pause",{agentId:"alpha"});
  for (const [m,p] of [["agent.open",{agentId:"alpha"}],["session.create",{agentId:"alpha",caller}],["jobs.run",{agentId:"alpha",job:"light"}]] as const)
    await assert.rejects(c.call(m,p),(e:any)=>e.error==="E_CONFLICT" && e.reason==="paused");
  await c.call("agent.resume",{agentId:"alpha"});
  const session=await c.call<any>("session.create",{agentId:"alpha",caller}); assert.ok(session.session.id);
  await c.call("agent.archive",{agentId:"alpha"});
  const offered=await c.call<any>("agent.export",{agentId:"alpha",offerOnly:true});
  await assert.rejects(c.call("agent.delete",{agentId:"alpha",confirmName:"Alpha",exportOfferId:offered.offerId}),(e:any)=>e.error==="E_NOT_AVAILABLE" && e.reason==="engine-erasure-unavailable");
  const person=await c.call<any>("identity.human.create",{caller,displayName:"Alex"});
  await c.call("user.role.set",{userId:person.id,role:"viewer"});
  who={userId:person.id,role:"owner",kind:"person"};
  await assert.rejects(c.call("agent.unarchive",{agentId:"alpha"}),(e:any)=>e.error==="E_DENIED");
  const rows=await c.call<any>("session.list",{allOwners:true}); assert.equal(rows.sessions[0].owner.startsWith("user:"),true); assert.equal(JSON.stringify(rows).includes("messages"),false);
});

test("a linked Member can use an assigned agent; foreign caller text cannot impersonate another person",async t=>{
  const home=tempDir("admin-linked-");const config=defaults();config.agents.alpha={};config.engine={reranker:{enabled:false},neo:{enabled:false},dreaming:{enabled:false},gc:{enabled:false}};writeFileSync(`${home}/config.json`,JSON.stringify(config));
  let who:Principal={userId:"local-owner",role:"owner",kind:"person"};
  const core=createCore({home,testInternals:flatTestInternals(),chatProvider:new FakeChatProvider(),rbac:{resolve:()=>who},dreams:{scheduler:false}});await core.start();const c=await connect({address:core.address,token:core.token});t.after(async()=>{await c.close();await core.stop({budgetMs:5000});});
  const person=await c.call<any>("identity.human.create",{caller,displayName:"Member"});
  const linked={channel:"cli",accountId:"offline-linked",userId:"member"};
  await c.call("identity.link",{caller,humanId:person.id,identity:linked});await c.call("agent.rights.set",{agentId:"alpha",userId:person.id,right:"use"});
  who={userId:person.id,role:"member",kind:"person"};
  const session=await c.call<any>("session.create",{caller:linked,agentId:"alpha"});
  assert.equal((await c.call<any>("session.list",{})).sessions[0].id,session.session.id);
  await assert.rejects(c.call("session.submit",{caller,sessionId:session.session.id,text:"impersonated"}),(e:any)=>e.error==="E_DENIED"&&e.reason==="caller-not-linked");
  await c.call("session.submit",{caller:linked,sessionId:session.session.id,text:"offline hello",wait:true});
  assert.equal((await c.call<any>("session.get",{caller:linked,sessionId:session.session.id})).session.turnCount,1);
});

test("pausing a running turn retains its reply and engine capture while blocking the next turn",async t=>{
  const home=tempDir("admin-inflight-");const config=defaults();config.agents.alpha={};config.engine={reranker:{enabled:false},neo:{enabled:false},dreaming:{enabled:false},gc:{enabled:false}};writeFileSync(`${home}/config.json`,JSON.stringify(config));
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;});const started=new Promise<void>(r=>{entered=r;});
  const core=createCore({home,testInternals:flatTestInternals(),chatProvider:new FakeChatProvider({gate:async()=>{entered();await gate;}}),dreams:{scheduler:false}});await core.start();const c=await connect({address:core.address,token:core.token});t.after(async()=>{release();await c.close();await core.stop({budgetMs:5000});});
  const session=await c.call<any>("session.create",{caller,agentId:"alpha"});
  const pending=c.call<any>("session.submit",{caller,sessionId:session.session.id,text:"I prefer deterministic offline fixtures.",wait:true});
  await started;await c.call("agent.pause",{agentId:"alpha"});release();assert.equal((await pending).state,"completed");
  const cards=await c.call<any>("memory.list",{caller,agentId:"alpha",since:0,limit:100});assert.ok(cards.items.length>0,"the in-flight turn still captures through the engine");
  await assert.rejects(c.call("session.submit",{caller,sessionId:session.session.id,text:"next"}),(e:any)=>e.error==="E_CONFLICT"&&e.reason==="paused");
});
