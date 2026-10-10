import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminStore } from "../../src/identity/admin-store.ts";
import { authorize } from "../../src/rbac/authorize.ts";
test("stored use/manage rights narrow role permissions and revocation takes effect immediately", t => {
  const store = new AdminStore({ path: ":memory:", ownerId: "owner" }); t.after(() => store.close());
  const member = { userId: "member", role: "member", kind: "person" } as const;
  assert.equal(authorize(store.resolve(member),"agent.use",{ kind: "agent",agentId:"alpha" }).effect,"deny");
  store.setRight("alpha","member","use");
  assert.equal(authorize(store.resolve(member),"agent.use",{ kind: "agent",agentId:"alpha" }).effect,"allow");
  assert.equal(authorize(store.resolve(member),"agent.manage",{ kind: "agent",agentId:"alpha" }).effect,"deny");
  store.setRight("alpha","member","manage");
  assert.equal(authorize(store.resolve(member),"agent.manage",{ kind: "agent",agentId:"alpha" }).effect,"allow");
  assert.equal(authorize(store.resolve({ ...member,role:"viewer" }),"agent.use",{ kind: "agent",agentId:"alpha" }).effect,"deny");
  store.setRight("alpha","member",null);
  assert.equal(authorize(store.resolve(member),"agent.use",{ kind: "agent",agentId:"alpha" }).effect,"deny");
});

test("session mutation checks stored agent use rights and never permits a foreign write", async t => {
  const { sessionWriteAccess }=await import("../../src/rpc/session-access.ts");
  const { SessionStore }=await import("../../src/session/store.ts");
  const { guardMethods }=await import("../../src/rbac/guard.ts");
  const roles=new AdminStore({path:":memory:",ownerId:"owner"}),sessions=new SessionStore({path:":memory:"});
  t.after(()=>{roles.close();sessions.close();});
  const own=sessions.createSession({agentId:"alpha",kind:"direct",owner:"self"}),foreign=sessions.createSession({agentId:"alpha",kind:"direct",owner:"other"});
  const executed:string[]=[]; const stubs=Object.fromEntries(["session.create","session.submit","session.cancel","session.archive"].map(m=>[m,async()=>{executed.push(m);return {};} ]));
  const raw=sessionWriteAccess({methods:stubs,sessions:()=>sessions,ownership:()=>["self"]});
  const methods=guardMethods(raw,{resolve:()=>roles.resolve({userId:"self",role:"member",kind:"person"}),now:()=>1});
  const ctx=()=>({requestId:"offline",connectionId:"offline",signal:new AbortController().signal});
  await assert.rejects(methods["session.submit"]!({sessionId:own.id},ctx()),(e:any)=>e.error==="E_DENIED");
  roles.setRight("alpha","self","use");await methods["session.submit"]!({sessionId:own.id},ctx());
  await assert.rejects(methods["session.submit"]!({sessionId:foreign.id},ctx()),(e:any)=>e.error==="E_NOT_FOUND");
  roles.setRight("alpha","self",null);await assert.rejects(methods["session.create"]!({agentId:"alpha"},ctx()),(e:any)=>e.error==="E_DENIED");
  assert.deepEqual(executed,["session.submit"]);
});
