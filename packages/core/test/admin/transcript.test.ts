import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../../src/session/store.ts";
import { createBreakGlass } from "../../src/rbac/break-glass.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import { sessionTranscriptSurface } from "../../src/rpc/session-overview.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import type { Principal } from "../../src/rbac/types.ts";
const context = () => ({ requestId: "offline", connectionId: "offline", signal: new AbortController().signal });
test("overview access is not transcript access: grant/revoke/expiry gate every transcript method", async t => {
  const store = new SessionStore({ path: ":memory:" }); t.after(() => store.close());
  const record = store.createSession({ kind: "direct", agentId: "alpha", owner: "other-principal" });
  const turn = store.beginTurn(record.id, "private question", 2); store.completeTurn(turn.turn.id, { text: "private answer", tokens: 3 });
  let now = 100_000; let who: Principal = { userId: "operator", role: "operator", kind: "person" }; const audit: any[] = [];
  const bg = createBreakGlass({ clock: () => now, audit: { append: e => { audit.push(e); } }, notify: () => {} });
  const raw = sessionTranscriptSurface({ sessions: () => store, breakglass: bg, ownership: () => ["own-principal"], personOf: () => "other" });
  const methods = guardMethods(raw, { resolve: () => who, now: () => now });
  const call = (m: string) => methods[m]!({ sessionId: record.id, messages: 20 }, context());
  const deny = (e: unknown) => e instanceof RpcError && e.error === "E_NOT_FOUND";
  for (const m of Object.keys(raw)) await assert.rejects(call(m), deny);
  who = { userId: "admin", role: "admin", kind: "person" };
  for (const m of Object.keys(raw)) await assert.rejects(call(m), deny);
  const granted = bg.request(who, { targetUserId: "other", reason: "Investigate incident", ttlMs: 60_000 });
  for (const m of Object.keys(raw)) { await call(m); }
  assert.equal(audit.filter(e => e.action === "break-glass.used").length, 3);
  bg.revoke(who, granted.id); for (const m of Object.keys(raw)) await assert.rejects(call(m), deny);
  bg.request(who, { targetUserId: "other", reason: "Investigate incident", ttlMs: 60_000 }); now += 60_000;
  for (const m of Object.keys(raw)) await assert.rejects(call(m), deny);
});

test("break-glass memory reads use engine ACL; expiry blocks the call before engine access", async t => {
  const { breakglassMemory }=await import("../../src/rpc/breakglass-memory.ts");
  const { createIdentityService }=await import("../../src/identity/service.ts");
  const { deriveUserPrincipal }=await import("../../src/identity/principals.ts");
  const { mkdtempSync,rmSync,mkdirSync }=await import("node:fs"); const { tmpdir }=await import("node:os"); const { join }=await import("node:path");
  const root=mkdtempSync(join(tmpdir(),"admin-memory-")); mkdirSync(join(root,"workspace"));
  const identity=createIdentityService({dbPath:join(root,"identity.sqlite"),clock:()=>100_000,audit:()=>{}});
  t.after(()=>{identity.close();rmSync(root,{recursive:true,force:true});});
  const who={userId:"owner",role:"owner",kind:"person"} as const;
  const person=identity.createHuman({displayName:"Other"},{user:who.userId,host:"offline",role:"owner",kind:"person"});
  let now=100_000,reads=0; const principals:string[]=[];
  const bg=createBreakGlass({clock:()=>now,audit:{append:()=>{}},notify:()=>{}});
  const card={ id:"card",scope:"user",text:"private",summary:"private",createdAt:1,origin:null,epistemicStatus:null };
  const engine={ memory:{ list:async(_q:any,p:any)=>{reads++;principals.push(p.user);return {agentId:"alpha",items:[card,{...card,id:"workspace",scope:"workspace"}],truncated:false};},show:async(_id:any,p:any)=>{reads++;principals.push(p.user);return card;} } } as any;
  const raw=breakglassMemory({ methods:{ "memory.list":async()=>({}),"memory.show":async()=>({}) },engine,identity,breakglass:bg,workspace:()=>join(root,"workspace") });
  const methods=guardMethods(raw,{resolve:()=>who,now:()=>now});
  const params={agentId:"alpha",targetUserId:person.id,since:0,id:"card"};
  await assert.rejects(methods["memory.list"]!(params,context()),(e:any)=>e.error==="E_DENIED"); assert.equal(reads,0);
  bg.request(who,{targetUserId:person.id,reason:"Investigate incident",ttlMs:60_000});
  const listed=await methods["memory.list"]!(params,context()) as any; assert.equal(listed.items.length,1);
  await methods["memory.show"]!(params,context()); assert.deepEqual(principals,[deriveUserPrincipal(person.id),deriveUserPrincipal(person.id)]);
  now+=60_000; await assert.rejects(methods["memory.show"]!(params,context()),(e:any)=>e.error==="E_DENIED"); assert.equal(reads,2);
});

test("ordinary memory reads filter agent-private cards by manage rights",async()=>{
  const {breakglassMemory}=await import("../../src/rpc/breakglass-memory.ts");
  const who={userId:"member",role:"member",kind:"person",agentRights:{alpha:"use"}} as const;
  const cards=[{scope:"user",id:"own"},{scope:"workspace",id:"shared"},{scope:"agent-private",id:"private"}];
  const raw=breakglassMemory({methods:{"memory.list":async()=>({items:cards})},engine:{} as any,identity:{resolve:()=>({humanId:"member"})} as any,breakglass:{} as any,workspace:()=>"offline"});
  const guarded=guardMethods(raw,{resolve:()=>who,now:()=>1});
  const result=await guarded["memory.list"]!({agentId:"alpha",caller:{}},context()) as any;
  assert.deepEqual(result.items.map((c:any)=>c.id),["own","shared"]);
});
